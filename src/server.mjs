import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CharacterStore } from "./character-store.mjs";
import { EventLog, makeEvent } from "./event-log.mjs";
import { ConsentService } from "./consent.mjs";
import { AuditLog } from "./audit.mjs";
import { CapabilityBus, registerBuiltins, ConsentRequiredError } from "./capability-bus.mjs";
import { createActorFactory } from "./actor.mjs";
import { BudgetExceededError } from "./actor.mjs";
import { createMockBrain } from "./brains/mock.mjs";
import { createOpenAIBrain } from "./brains/openai.mjs";
import { createLocalBrain } from "./brains/local.mjs";
import { EDITION, PLATFORM, cloudApiAllowed, CLOUD_API_BLOCKED } from "./edition.mjs";
import { describePermissions } from "./plugin-manifest.mjs";
import { PluginHost } from "./plugin-host.mjs";
import { VirtualHome } from "./devices.mjs";
import { HomeAssistantAdapter } from "./adapters/home-assistant.mjs";
import { EngineScheduler } from "./scheduler.mjs";
import { attachWebSocket } from "./websocket.mjs";
import { RateLimiter } from "./rate-limit.mjs";
import { rebuildStateFromEvents } from "./recovery.mjs";
import { importDshpet } from "./import/dshpet.mjs";
import { IdentityStore } from "./federation/identity.mjs";
import { PeerStore } from "./federation/peers.mjs";
import { FederationNode } from "./federation/node.mjs";
import QRCode from "qrcode";

import { CourierClient, CourierPool } from "./federation/courier.mjs";
import { GroupStore } from "./federation/groups.mjs";
import { GuestTokenStore } from "./guest-tokens.mjs";
import { createInvite, parseInvite } from "./federation/invite.mjs";
import { PostcardStore } from "./federation/postcards.mjs";
import { HumanStore } from "./federation/human.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 邀请里的地址排序：同一 Wi-Fi 的 LAN 优先，其次 Tailscale，然后公网，最后 loopback。 */
function hintRank(host) {
  const value = String(host ?? "");
  if (!value) return 9;
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") return 4;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return 1;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value)) return 0;
  return 2;
}

export async function createHub(options = {}) {
  const dataDir = options.dataDir ?? process.env.VRLINK_V2_DATA ?? path.join(ROOT, "data");
  const uiDir = options.uiDir ?? path.join(ROOT, "ui");
  const pluginsDir = options.pluginsDir ?? path.join(ROOT, "plugins");
  const token = options.token ?? process.env.VRLINK_V2_TOKEN ?? "";
  // 默认回环不限流（界面自己的轮询）；测试可关掉，验证 429。
  const rateLimitLoopback = options.rateLimitLoopback !== false;
  const onebotHealthUrl = options.onebotHealthUrl ?? process.env.VRLINK_ONEBOT_HEALTH_URL ?? "http://127.0.0.1:5700/health";
  const biliHealthUrl = options.biliHealthUrl ?? process.env.VRLINK_BILI_HEALTH_URL ?? "http://127.0.0.1:5701/health";

  const store = new CharacterStore(path.join(dataDir, "characters"));
  // seed 发行版默认不塞演示角色；dev 版保持原来的演示行为。
  const seedDemo = process.env.VRLINK_SEED_DEMO !== undefined
    ? process.env.VRLINK_SEED_DEMO !== "0"
    : EDITION !== "seed";
  await store.init({ seed: seedDemo });
  const identity = await new IdentityStore({
    dataDir: path.join(dataDir, "node"),
    charactersDir: path.join(dataDir, "characters"),
    passphrase: process.env.VRLINK_NODE_PASSPHRASE ?? "",
  }).init();
  const eventLog = new EventLog(path.join(dataDir, "characters"), { signer: identity });
  for (const character of await store.list()) {
    const state = await store.state(character.id);
    const events = await eventLog.read(character.id);
    if (!state || Number(state.eventCount ?? 0) !== events.length) {
      await store.updateState(character.id, rebuildStateFromEvents(events, state ?? {}));
    }
  }
  const audit = new AuditLog(path.join(dataDir, "characters"));
  const consent = await new ConsentService(path.join(dataDir, "consent.json")).init();
  const home = options.home ?? (await createHomeAdapter(options));
  const bus = new CapabilityBus({ consent, audit });
  registerBuiltins({ bus, store, eventLog, home });
  const pluginHost = await new PluginHost({
    pluginsDir,
    dataDir: path.join(dataDir, "plugins"),
    capabilities: bus,
    log: (line) => console.log(line),
  }).init();

  const DEFAULT_ACTIONS = ["message.send", "memory.add", "time.now", "device.command", "device.list"];

  async function ensureDefaultGrant(characterId, grantedBy = "system:seed") {
    const active = consent
      .list(characterId)
      .filter((grant) => !grant.revoked && grant.riskMax === "low");
    const covered = DEFAULT_ACTIONS.every((action) =>
      active.some((grant) => grant.actions.includes("*") || grant.actions.includes(action)),
    );
    if (covered) return null;
    return consent.grant({
      characterId,
      scope: `character:${characterId}`,
      actions: DEFAULT_ACTIONS,
      riskMax: "low",
      grantedBy,
    });
  }

  for (const character of await store.list()) {
    await ensureDefaultGrant(character.id);
  }

  const makeBrain = async (character) => {
    const engine = character.brain?.engine ?? "mock";
    if ((engine === "api" || engine === "openai") && !cloudApiAllowed()) {
      console.warn(`[edition] ${character.id} 的云端大脑被发行版门禁拦下，回退 mock`);
      return createMockBrain();
    }
    if (engine === "api" || engine === "openai") {
      return createOpenAIBrain({
        baseUrl: process.env.VRLINK_BRAIN_BASE_URL,
        apiKey: process.env.VRLINK_BRAIN_API_KEY,
        model: character.brain?.model || process.env.VRLINK_BRAIN_MODEL,
        temperature: character.brain?.temperature,
      });
    }
    if (engine === "local") {
      return createLocalBrain({
        baseUrl: process.env.VRLINK_LOCAL_BASE_URL,
        apiKey: process.env.VRLINK_LOCAL_API_KEY,
        model: character.brain?.model || process.env.VRLINK_LOCAL_MODEL,
        temperature: character.brain?.temperature,
      });
    }
    return createMockBrain();
  };

  const scheduler = new EngineScheduler({
    apiConcurrency: Number(options.apiConcurrency ?? process.env.VRLINK_API_CONCURRENCY ?? 4),
    localConcurrency: 1,
  });
  const actors = createActorFactory({ store, eventLog, capabilities: bus, makeBrain, scheduler });
  const a2aTasks = new Map();

  const peerStore = await new PeerStore(path.join(dataDir, "peers")).init();
  const nodeName = options.federationName ?? process.env.VRLINK_FEDERATION_NAME ?? "";
  const publicHost = options.publicHost ?? process.env.VRLINK_PUBLIC_HOST ?? "";
  const postcardStore = await new PostcardStore({
    dir: path.join(dataDir, "postcards"),
    identity,
    name: nodeName,
  }).init();
  const groupStore = await new GroupStore({
    dir: path.join(dataDir, "federation"),
    identity,
    name: nodeName,
  }).init();
  const guestTokens = await new GuestTokenStore({ dir: path.join(dataDir, "guest-tokens") }).init();
  // 人-人通道：和角色事件日志完全分开，存 data/human（见 federation/human.mjs）
  const humanStore = await new HumanStore({
    dir: path.join(dataDir, "human"),
    identity,
    name: nodeName,
  }).init();
  const courierRaw = options.courierUrls ?? process.env.VRLINK_COURIER_URLS ?? options.courierUrl ?? process.env.VRLINK_COURIER_URL ?? "";
  const courierUrls = String(courierRaw).split(",").map((value) => value.trim()).filter(Boolean);
  const courierTokens = String(options.courierTokens ?? process.env.VRLINK_COURIER_TOKENS ?? options.courierToken ?? process.env.VRLINK_COURIER_TOKEN ?? "")
    .split(",")
    .map((value) => value.trim());
  const courier = courierUrls.length === 1
    ? new CourierClient({ url: courierUrls[0], identity, token: courierTokens[0] ?? "" })
    : courierUrls.length > 1
      ? new CourierPool({
          identity,
          clients: courierUrls.map((url, index) => new CourierClient({ url, identity, token: courierTokens[index] ?? courierTokens[0] ?? "" })),
        })
      : null;
  const federation = new FederationNode({    identity,
    eventLog,
    store,
    peerStore,
    courier,
    courierPollMs: options.courierPollMs ?? process.env.VRLINK_COURIER_POLL_MS ?? 15000,
    dataDir,
    name: nodeName,
    autoConfirm: options.federationAutoAccept ?? process.env.VRLINK_FEDERATION_AUTO_ACCEPT === "1",
    log: (line) => console.log(line),
    onChat: async ({ nodeId, characterId, text, group, peer }) => {
      if (group?.id) {
        const before = groupStore.get(group.id)?.messages?.slice(-1)?.[0]?.at ?? 0;
        await groupStore.receive({
          group,
          from: nodeId,
          fromName: peer?.name ?? "",
          text,
          at: Date.now(),
        });
        broadcastUi("group", { groupId: group.id, fromSelf: false });
        // 群消息也要能在手机锁屏/后台时提醒（原来只有群快照会触发通知，
        // 真正的群聊消息到了反而没提醒）。
        try {
          const after = groupStore.get(group.id)?.messages?.slice(-1)?.[0];
          if (after && Number(after.at ?? 0) > Number(before) && typeof globalThis.__vrlinkNotify === "function") {
            const sender = String(after.fromName ?? "").trim() || peer?.human?.name || peer?.name || "";
            globalThis.__vrlinkNotify({
              kind: "group",
              name: sender ? `${sender} · ${group.name ?? "群聊"}` : (group.name ?? "群聊"),
              text: String(after.text ?? "").slice(0, 200),
              at: Number(after.at ?? Date.now()),
            });
          }
        } catch (error) {
          console.log(`[group] notify hook failed: ${error?.message ?? error}`);
        }
        return;
      }
      const actor = await actors.get(characterId);
      actor
        .enqueue({
          type: "message.received",
          source: { body: "federation", thread: `peer:${nodeId}`, actor: { id: nodeId } },
          visibility: "private",
          content: { text },
        })
        .catch((error) => console.error(`[federation] chat failed: ${error?.message ?? error}`));
    },
    onGroup: async ({ group }) => {
      const before = groupStore.get(group?.id)?.messages?.slice(-1)?.[0]?.at ?? 0;
      await groupStore.applyRemote(group);
      broadcastUi("groups", { id: group?.id });
      // 群消息也要能在手机熄屏时提醒
      try {
        const after = groupStore.get(group?.id)?.messages?.slice(-1)?.[0];
        if (after && Number(after.at ?? 0) > Number(before) && typeof globalThis.__vrlinkNotify === "function") {
          globalThis.__vrlinkNotify({
            kind: "group",
            name: group?.name ?? "群聊",
            text: String(after.text ?? "").slice(0, 200),
            at: Number(after.at ?? Date.now()),
          });
        }
      } catch (error) {
        console.log(`[group] notify hook failed: ${error?.message ?? error}`);
      }
    },
    // 人-人消息：验签后落 data/human，绝不进任何角色的队列/上下文。
    onHuman: async ({ nodeId, peerCert, message }) => {
      const result = await humanStore.receive({ nodeId, peerCert, message });
      if (!result.ok) {
        console.log(`[human] rejected message from ${nodeId}: ${result.code}`);
        return false;
      }
      broadcastUi("human", { nodeId, message });
      // 手机端熄屏/后台时要弹系统通知：交给宿主（main.js）注册的钩子
      try {
        const peer = await peerStore.get(nodeId);
        const name = peer?.human?.name || peer?.name || "";
        if (typeof globalThis.__vrlinkNotify === "function") {
          globalThis.__vrlinkNotify({
            kind: "human",
            nodeId,
            name,
            text: String(message.text ?? "").slice(0, 200),
            at: Number(message.at ?? Date.now()),
          });
        }
      } catch (error) {
        console.log(`[human] notify hook failed: ${error?.message ?? error}`);
      }
      return true;
    },
    humanCard: () => humanStore.card(),
  });
  // 邀请窗口：打开「邀请朋友」就把联邦监听开放到局域网（并持久化），
  // 10 分钟内收到的配对请求直接接受 —— 对方扫码点一下就能加上，不用先手动开组网。
  const INVITE_WINDOW_MS = Math.max(60000, Number(options.inviteWindowMs ?? process.env.VRLINK_INVITE_WINDOW_MS ?? 10 * 60 * 1000));
  let inviteWindowUntil = 0;

  async function ensureInviteNetworking() {
    if (!federation.listenAddress) return { opened: false, reason: "not-listening" };
    const host = String(federation.listenAddress.host ?? "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      return { opened: false, alreadyOpen: true, host, port: federation.listenAddress.port };
    }
    await federation.relisten("0.0.0.0");
    // 写进设置：下次启动仍然可被已加的好友连上（否则重启后又回到只听本机）
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "network.json"),
        `${JSON.stringify({ enabled: true, host: "0.0.0.0", port: federation.listenAddress.port, updatedAt: Date.now() }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      console.error(`[network] persist failed: ${error?.message ?? error}`);
    }
    return { opened: true, host: "0.0.0.0", port: federation.listenAddress.port };
  }

  federation.on("peer-human", async ({ nodeId, human }) => {
    // 两处写入各自兜底：线程名片写失败不应连带让联系人名片也丢失（Windows 上偶发 rename 争用）。
    try {
      await humanStore.rememberPeer(nodeId, human);
    } catch (error) {
      console.error(`[human] thread card failed: ${error?.message ?? error}`);
    }
    try {
      await peerStore.touch(nodeId, {
        human: {
          name: human.name ?? "",
          avatarText: human.avatarText ?? "",
          avatarData: human.avatarData ?? "",
          updatedAt: human.updatedAt ?? 0,
        },
      });
    } catch (error) {
      console.error(`[human] peer card failed: ${error?.message ?? error}`);
    }
  });

  /* ---------- 扫码/粘贴加入：异步配对尝试 ----------
   * 配对要等对方在「新的朋友」里确认同一组 SAS，可能几十秒；
   * 所以 /api/federation/connect 支持 async:true，立刻返回 attempt id，前端轮询。
   */
  const connectAttempts = new Map();
  const CONNECT_ATTEMPT_TTL = 10 * 60 * 1000;
  function sweepAttempts() {
    const now = Date.now();
    for (const [id, attempt] of connectAttempts) {
      if (now - attempt.startedAt > CONNECT_ATTEMPT_TTL) connectAttempts.delete(id);
    }
  }
  function publicAttempt(attempt) {
    return {
      id: attempt.id,
      state: attempt.state,
      startedAt: attempt.startedAt,
      tried: attempt.tried,
      peer: attempt.peer,
      code: attempt.code,
      error: attempt.error,
    };
  }
  function startConnectAttempt({ invite = "", host = "", port = 0, autoConfirm = false, pairTimeoutMs = 180000 } = {}) {
    sweepAttempts();
    const id = `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const attempt = {
      id,
      state: "pending",
      startedAt: Date.now(),
      tried: [],
      peer: null,
      code: "",
      error: "",
      autoConfirm,
    };
    connectAttempts.set(id, attempt);
    (async () => {
      try {
        if (invite) {
          const parsed = parseInvite(invite);
          // 扫码后要尽快让对方看到申请：按 LAN → Tailscale → 公网 → loopback 排序，
          // 每个地址最多等 4 秒（原默认 10 秒，扫完码要干等十几秒）。
          const hints = [...parsed.hints].sort((a, b) => hintRank(a.host) - hintRank(b.host));
          for (const hint of hints) {
            attempt.tried.push(`${hint.host}:${hint.port}`);
            try {
              const session = await federation.connect(hint.host, hint.port, {
                autoConfirm,
                pairTimeoutMs,
                timeoutMs: 4000,
              });
              attempt.state = "ok";
              attempt.peer = {
                nodeId: session.nodeId,
                name: session.peer?.name ?? "",
                sas: session.sas,
                grants: session.peer?.record?.grants ?? {},
              };
              return;
            } catch (error) {
              if (error?.code === "PEER_BLOCKED") {
                attempt.state = "error";
                attempt.code = "PEER_BLOCKED";
                attempt.error = String(error.message ?? error);
                return;
              }
              attempt.error = String(error?.message ?? error);
            }
          }
          attempt.state = "error";
          attempt.code = attempt.code || "CONNECT_FAILED";
          attempt.error = attempt.error || `all hints failed: ${attempt.tried.join(", ")}`;
          return;
        }
        const session = await federation.connect(host, Number(port), { autoConfirm, pairTimeoutMs });
        attempt.state = "ok";
        attempt.peer = {
          nodeId: session.nodeId,
          name: session.peer?.name ?? "",
          sas: session.sas,
          grants: session.peer?.record?.grants ?? {},
        };
      } catch (error) {
        attempt.state = "error";
        attempt.code = error?.code ?? "CONNECT_FAILED";
        attempt.error = String(error?.message ?? error);
      }
    })();
    return attempt;
  }
  federation.on("postcard", async ({ postcard, fromCert }) => {
    if (!postcard || postcard.to !== identity.publicIdentity().nodeId) return;
    try {
      await postcardStore.receive(postcard, fromCert);
      console.log(`[federation] postcard received from ${postcard.fromName || postcard.from}`);
    } catch (error) {
      console.error(`[federation] postcard rejected: ${error?.message ?? error}`);
    }
  });
  const federationPort = options.federationPort ?? (process.env.VRLINK_FEDERATION_PORT ? Number(process.env.VRLINK_FEDERATION_PORT) : null);
  async function syncGroup(snapshot, { extra = [], overrideByNode = {} } = {}) {
    if (!snapshot) return [];
    const self = identity.publicIdentity().nodeId;
    const members = [...(snapshot.members ?? []), ...extra];
    const results = [];
    for (const member of members) {
      const nodeId = String(member?.nodeId ?? member ?? "");
      if (!nodeId || nodeId === self) continue;
      const payload = overrideByNode[nodeId] ?? snapshot;
      try {
        await federation.sendGroup(nodeId, payload);
        results.push({ nodeId, ok: true });
      } catch (error) {
        results.push({ nodeId, ok: false, error: String(error?.message ?? error) });
      }
    }
    broadcastUi("groups", { id: snapshot.id });
    return results;
  }
  // 一键组网状态持久化：重启后按上次的选择决定联邦监听地址（默认仍只听本机）
  const networkPrefsFile = path.join(dataDir, "network.json");
  let networkPrefs = null;
  try {
    networkPrefs = JSON.parse(await fs.readFile(networkPrefsFile, "utf8"));
  } catch {
    networkPrefs = null;
  }
  if (federationPort !== null && federationPort !== undefined) {
    await federation.listen(
      Number(federationPort),
      options.federationHost ?? process.env.VRLINK_FEDERATION_HOST ?? (networkPrefs?.enabled ? "0.0.0.0" : "127.0.0.1"),
    );
    console.log(`VRlink federation listening on ${federation.listenAddress.host}:${federation.listenAddress.port}`);
  } else if (courier) {
    await federation.init();
  }

  // 后台保活：定时检查已配对但没连上的好友，自动重连；连上后把对方离线期间排队的
  // 人-人消息补发出去（发件人不用手动重发）。
  const reconnectState = new Map(); // nodeId -> 上次尝试时间
  const humanOutbox = new Map(); // nodeId -> [message]，最多各留 50 条
  // 未送达的人-人消息要落盘：以前只放内存，App 一关（或手机启动器被杀）就全丢了。
  const humanOutboxFile = path.join(dataDir, "human", "outbox.json");
  // 群消息也要有补发队列：某个成员临时掉线时，消息不能只在他那里"未收到"就完了。
  const groupOutbox = new Map(); // `${groupId}|${nodeId}` -> { group, text, at }
  const groupOutboxFile = path.join(dataDir, "federation", "group-outbox.json");
  const reconnectMs = Math.max(2000, Number(options.reconnectMs ?? process.env.VRLINK_RECONNECT_MS ?? 30000));

  async function persistHumanOutbox() {
    try {
      await fs.mkdir(path.dirname(humanOutboxFile), { recursive: true });
      const tmp = `${humanOutboxFile}.${process.pid}.tmp`;
      const payload = { v: 1, savedAt: Date.now(), outbox: Object.fromEntries(humanOutbox) };
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, humanOutboxFile);
    } catch (error) {
      console.error(`[human] outbox persist failed: ${error?.message ?? error}`);
    }
  }

  async function loadHumanOutbox() {
    try {
      const saved = JSON.parse(await fs.readFile(humanOutboxFile, "utf8"));
      for (const [nodeId, list] of Object.entries(saved?.outbox ?? {})) {
        if (!nodeId || !Array.isArray(list)) continue;
        const valid = list.filter((item) => item && item.id && item.to === nodeId);
        if (valid.length) humanOutbox.set(nodeId, valid.slice(-50));
      }
      if (humanOutbox.size) console.log(`[human] outbox restored: ${humanOutbox.size} peer(s)`);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`[human] outbox load failed: ${error?.message ?? error}`);
    }
  }
  await loadHumanOutbox();

  async function persistGroupOutbox() {
    try {
      await fs.mkdir(path.dirname(groupOutboxFile), { recursive: true });
      const tmp = `${groupOutboxFile}.${process.pid}.tmp`;
      const payload = { v: 1, savedAt: Date.now(), outbox: Object.fromEntries(groupOutbox) };
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, groupOutboxFile);
    } catch (error) {
      console.error(`[group] outbox persist failed: ${error?.message ?? error}`);
    }
  }

  async function loadGroupOutbox() {
    try {
      const saved = JSON.parse(await fs.readFile(groupOutboxFile, "utf8"));
      for (const [key, item] of Object.entries(saved?.outbox ?? {})) {
        if (!key.includes("|") || !item?.text || !item?.group?.id) continue;
        groupOutbox.set(key, item);
      }
      if (groupOutbox.size) console.log(`[group] outbox restored: ${groupOutbox.size} entr(ies)`);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`[group] outbox load failed: ${error?.message ?? error}`);
    }
  }
  await loadGroupOutbox();

  function rememberGroupOutbox(groupId, nodeId, group, text) {
    if (!groupId || !nodeId || !text) return;
    groupOutbox.set(`${groupId}|${nodeId}`, { group, text, at: Date.now() });
    persistGroupOutbox().catch(() => {});
  }

  async function flushGroupOutbox(nodeId) {
    let sent = 0;
    for (const [key, item] of [...groupOutbox.entries()]) {
      if (!key.endsWith(`|${nodeId}`)) continue;
      try {
        await federation.chat(nodeId, "group", item.text, { group: item.group });
        groupOutbox.delete(key);
        sent += 1;
      } catch {
        /* 还没连上，留着 */
      }
    }
    if (sent) await persistGroupOutbox();
    return { sent, left: groupOutbox.size };
  }

  function rememberHumanOutbox(nodeId, message) {
    if (!nodeId || !message?.id) return;
    const list = humanOutbox.get(nodeId) ?? [];
    if (!list.some((item) => item.id === message.id)) list.push(message);
    humanOutbox.set(nodeId, list.slice(-50));
    persistHumanOutbox().catch(() => {});
  }

  async function flushHumanOutbox(nodeId) {
    const list = humanOutbox.get(nodeId);
    if (!list?.length) return { sent: 0, left: 0 };
    const remaining = [];
    let sent = 0;
    for (const message of list) {
      try {
        await federation.humanSend(nodeId, message);
        sent += 1;
      } catch {
        remaining.push(message);
      }
    }
    if (remaining.length) humanOutbox.set(nodeId, remaining);
    else humanOutbox.delete(nodeId);
    await persistHumanOutbox();
    return { sent, left: remaining.length };
  }

  async function ensureConnections() {
    try {
      const peers = await peerStore.list();
      const live = new Set(federation.status().sessions.map((session) => session.nodeId));
      for (const peer of peers) {
        if (!peer?.nodeId || peer.blocked) continue;
        if (live.has(peer.nodeId)) {
          if (humanOutbox.has(peer.nodeId)) await flushHumanOutbox(peer.nodeId);
          if ([...groupOutbox.keys()].some((key) => key.endsWith(`|${peer.nodeId}`))) {
            await flushGroupOutbox(peer.nodeId);
          }
          continue;
        }
        const last = reconnectState.get(peer.nodeId) ?? 0;
        if (Date.now() - last < Math.min(reconnectMs, 20000)) continue;
        reconnectState.set(peer.nodeId, Date.now());
        const order = { lan: 0, tailscale: 1, public: 2, loopback: 3 };
        const hints = [...(peer.hints ?? [])]
          .filter((hint) => hint?.host && hint?.port)
          .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
        for (const hint of hints) {
          try {
            await federation.connect(hint.host, hint.port, { autoConfirm: false, timeoutMs: 4000 });
            break;
          } catch {
            /* 对端离线/端口不通：下一个 hint */
          }
        }
      }
    } catch {
      /* 后台保活失败不影响主流程 */
    }
  }

  federation.on("session", (session) => {
    broadcastUi("status", { session: session?.nodeId ?? "" });
    flushHumanOutbox(session.nodeId).catch((error) =>
      console.error(`[human] outbox flush failed: ${error?.message ?? error}`),
    );
    flushGroupOutbox(session.nodeId).catch((error) =>
      console.error(`[group] outbox flush failed: ${error?.message ?? error}`),
    );
  });

  federation.on("pair-request", () => broadcastUi("pending", {}));
  federation.on("pair-confirmed", () => broadcastUi("pending", {}));

  setTimeout(ensureConnections, 2500);
  const reconnectTimer = setInterval(ensureConnections, reconnectMs);
  reconnectTimer.unref?.();

  const limiter = new RateLimiter({
    limit: Number(options.rateLimit ?? process.env.VRLINK_RATE_LIMIT ?? 120),
    windowMs: 60000,
  });

  const sse = new Map();

  // 全局 UI 事件流（v0.6.0）：人-人 / 群聊 / 列表 / 配对 / 资料变化即时推给页面，
  // 不再依赖 1.5s / 3s 轮询。SSE 单向推送，浏览器自带断线重连。
  const uiStreams = new Set();
  function broadcastUi(event, data = {}) {
    if (!uiStreams.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...uiStreams]) {
      try {
        res.write(payload);
      } catch {
        uiStreams.delete(res);
      }
    }
  }

  eventLog.on("event", (event) => {
    const clients = sse.get(event.characterId);
    if (clients) {
      for (const res of clients) {
        try {
          res.write(`event: life\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          clients.delete(res);
        }
      }
    }
    broadcastUi("list", { characterId: event.characterId, type: event.type });
    if (safeMode) return;
    pluginHost.dispatch(event).catch((error) => console.error(`[plugin] dispatch failed: ${error?.message ?? error}`));
  });

  let emergencyStop = false;
  let safeMode = false;

  async function runA2ATask(characterId, text) {
    const event = makeEvent({
      characterId,
      type: "message.received",
      body: "a2a",
      thread: "a2a",
      actor: { id: "a2a-client", name: "A2A" },
      visibility: "private",
      content: { text },
    });
    const actor = await actors.get(characterId);
    const result = await actor.enqueue(event);
    const reply = result.produced.find((item) => item.type === "message.sent")?.content?.text ?? "";
    const stamp = Date.now().toString(36);
    const task = {
      kind: "task",
      id: `task_${stamp}_${Math.random().toString(36).slice(2, 6)}`,
      contextId: `ctx_${characterId}`,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [{ artifactId: `artifact_${stamp}`, parts: [{ kind: "text", text: reply }] }],
    };
    a2aTasks.set(task.id, task);
    return task;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = decodeURIComponent(url.pathname);

    try {
      const guestPublic = p.startsWith("/guest/") || (p.startsWith("/api/guest/") && req.method === "GET");
      if (!guestPublic && !authorized(req, url, token)) return sendJson(res, 401, { ok: false, error: "unauthorized" });      const limitedPath = p.startsWith("/api/") || p.startsWith("/v1/") || p === "/a2a";
      // 本机回环 = 自己的界面/桌面壳：不限流。
      // 以前它和远程访客共用 120/min 的桶，界面自己的轮询（聊天 1.5s + 列表 3s×4 个接口）
      // 一分钟就能打满，于是出现 "too many requests"，关到托盘后连提示窗的轮询也被挡掉。
      const loopback = /^(::ffff:)?(127\.0\.0\.1|::1)$/.test(String(req.socket.remoteAddress ?? ""));
      if (limitedPath && p !== "/api/health" && !(loopback && rateLimitLoopback)) {
        const rate = limiter.check(`${req.socket.remoteAddress ?? "local"}:${token ? "token" : "anon"}`);
        if (!rate.ok) {
          res.setHeader("retry-after", String(rate.retryAfter));
          return sendJson(res, 429, {
            ok: false,
            code: "RATE_LIMITED",
            error: "too many requests",
            retryAfter: rate.retryAfter,
          });
        }
      }
      if (p === "/api/health") return sendJson(res, 200, { ok: true, app: "vrlink-v2", edition: EDITION, platform: PLATFORM });
      // 全局 UI 事件流：一次连接，所有即时更新（人-人/群聊/列表/配对/资料）
      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 1500\n\n");
        res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
        uiStreams.add(res);
        const heartbeat = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* ignore */
          }
        }, 20000);
        heartbeat.unref?.();
        req.on("close", () => {
          clearInterval(heartbeat);
          uiStreams.delete(res);
        });
        return;
      }
      if (p === "/api/identity" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, node: identity.publicIdentity() });
      }
      if (p === "/api/guest-tokens" && req.method === "POST") {
        const body = await readJson(req);
        const characterId = String(body?.characterId ?? "").trim();
        if (!characterId) return sendJson(res, 400, { ok: false, error: "characterId required" });
        const character = await store.load(characterId).catch(() => null);
        if (!character) return sendJson(res, 404, { ok: false, error: "character not found" });
        const created = await guestTokens.create({
          characterId,
          label: String(body?.label ?? character.name ?? "").slice(0, 80),
          ttlHours: Number(body?.ttlHours ?? 24),
        });
        const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
        const host = String(req.headers.host ?? "127.0.0.1");
        const base = String(options.publicUrl ?? process.env.VRLINK_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, "");
        return sendJson(res, 200, {
          ok: true,
          token: created.record.id,
          url: `${base}/guest/${created.token}`,
          expiresAt: created.record.expiresAt,
          label: created.record.label,
        });
      }
      if (p === "/api/guest-tokens" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, tokens: guestTokens.list() });
      }
      if (p.startsWith("/api/guest-tokens/") && p.endsWith("/revoke") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/guest-tokens/".length, -"/revoke".length));
        const revoked = await guestTokens.revoke(id);
        if (!revoked) return sendJson(res, 404, { ok: false, error: "token not found" });
        return sendJson(res, 200, { ok: true, revoked });
      }
      if (p.startsWith("/api/guest/") && req.method === "GET") {
        const guestToken = decodeURIComponent(p.slice("/api/guest/".length));
        const record = await guestTokens.resolve(guestToken);
        if (!record) return sendJson(res, 404, { ok: false, error: "guest link expired or invalid" });
        const character = await store.load(record.characterId).catch(() => null);
        if (!character) return sendJson(res, 404, { ok: false, error: "character not found" });
        const events = (await eventLog.read(record.characterId, { limit: 100 }))
          .filter((event) => event.visibility === "public")
          .slice(-30)
          .map((event) => ({ type: event.type, at: event.at, text: event.content?.text ?? "" }));
        return sendJson(res, 200, {
          ok: true,
          guest: {
            name: character.name,
            identity: character.persona?.identity ?? "",
            events,
            expiresAt: record.expiresAt,
          },
        });
      }
      /* ---------- 人-人通道（owner channel，0.3.0） ---------- */
      if (p === "/api/human/self" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, self: await humanStore.getSelf(), card: await humanStore.card() });
      }
      if (p === "/api/human/self" && (req.method === "PATCH" || req.method === "POST")) {
        const body = await readJson(req);
        const self = await humanStore.setSelf({ name: body?.name, avatarText: body?.avatarText, avatarData: body?.avatarData });
        // 名片改了主动推给在线好友，对端不用重连
        await federation.broadcastProfile().catch(() => {});
        broadcastUi("profile", { self });
        return sendJson(res, 200, { ok: true, self, card: await humanStore.card() });
      }
      if (p === "/api/human/threads" && req.method === "GET") {
        const threads = await humanStore.threads();
        const peers = await peerStore.list();
        const byNode = new Map(threads.map((item) => [item.nodeId, item]));
        for (const peer of peers) {
          if (!peer?.nodeId || byNode.has(peer.nodeId)) continue;
          byNode.set(peer.nodeId, {
            nodeId: peer.nodeId,
            name: peer.human?.name || peer.name || "",
            avatarText: peer.human?.avatarText || "",
            avatarData: peer.human?.avatarData || "",
            count: 0,
            unread: 0,
            lastText: "",
            lastAt: 0,
            lastFromSelf: false,
            readAt: 0,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          threads: [...byNode.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
        });
      }
      if (p.startsWith("/api/human/") && p.endsWith("/messages") && req.method === "GET") {
        const nodeId = decodeURIComponent(p.slice("/api/human/".length, -"/messages".length));
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const peer = await peerStore.get(nodeId);
        if (!peer) return sendJson(res, 404, { ok: false, error: "peer not found" });
        const messages = await humanStore.list(nodeId, { since, limit });
        return sendJson(res, 200, {
          ok: true,
          nodeId,
          peer: {
            name: peer.human?.name || peer.name || "",
            avatarText: peer.human?.avatarText || "",
            avatarData: peer.human?.avatarData || "",
          },
          messages,
        });
      }
      if (p.startsWith("/api/human/") && p.endsWith("/messages") && req.method === "POST") {
        const nodeId = decodeURIComponent(p.slice("/api/human/".length, -"/messages".length));
        const body = await readJson(req);
        const text = String(body?.text ?? "").trim();
        if (!nodeId || !text) return sendJson(res, 400, { ok: false, error: "nodeId and text required" });
        if (text.length > 4000) return sendJson(res, 413, { ok: false, error: "text too long" });
        const peer = await peerStore.get(nodeId);
        if (!peer) return sendJson(res, 404, { ok: false, error: "peer not found" });
        let message;
        try {
          message = await humanStore.appendLocal(nodeId, text);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        broadcastUi("human", { nodeId, message, fromSelf: true });
        let delivery;
        try {
          const response = await federation.humanSend(nodeId, message);
          delivery = {
            ok: true,
            state: response?.t === "queued" ? "queued" : "sent",
            envelopeId: response?.id ?? "",
          };
        } catch (error) {
          // 本地已经存下了；对方离线/抖一下就排队，等连上自动补发（发件人不用手动重发）。
          // 只有"永久性"的拒绝（对方版本不支持 / 没授权）才不排队，避免死信无限重试。
          const code = error?.code ?? "SEND_FAILED";
          const permanent = code === "PEER_NO_HUMAN" || code === "HUMAN_NOT_GRANTED";
          if (!permanent) {
            rememberHumanOutbox(nodeId, message);
            delivery = {
              ok: false,
              state: "queued",
              queued: true,
              code,
              error: String(error?.message ?? error),
            };
          } else {
            delivery = {
              ok: false,
              state: "stored",
              code,
              error: String(error?.message ?? error),
            };
          }
        }
        return sendJson(res, 200, { ok: true, message, delivery });
      }
      if (p.startsWith("/api/human/") && p.endsWith("/read") && req.method === "POST") {
        const nodeId = decodeURIComponent(p.slice("/api/human/".length, -"/read".length));
        const body = await readJson(req);
        const at = Number(body?.at ?? Date.now());
        const readAt = await humanStore.markRead(nodeId, at);
        return sendJson(res, 200, { ok: true, nodeId, readAt });
      }
      if (p === "/api/human/peers" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, peers: await peerStore.list() });
      }

      if (p === "/api/federation/status" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          federation: federation.status(),
          peers: await peerStore.list(),
        });
      }
      if (p === "/api/federation/card" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, card: federation.contactCard() });
      }
      if (p === "/api/federation/invite/parse" && req.method === "POST") {
        const body = await readJson(req);
        const text = String(body?.invite ?? "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "invite required" });
        try {
          const parsed = parseInvite(text);
          const known = parsed.nodeId ? Boolean(await peerStore.get(parsed.nodeId)) : false;
          return sendJson(res, 200, {
            ok: true,
            invite: { nodeId: parsed.nodeId, name: parsed.name, hints: parsed.hints },
            known,
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: "BAD_INVITE", error: String(error?.message ?? error) });
        }
      }
      if (p === "/api/federation/connect/attempt" && req.method === "GET") {
        const id = String(url.searchParams.get("id") ?? "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "id required" });
        const attempt = connectAttempts.get(id);
        if (!attempt) return sendJson(res, 404, { ok: false, error: "attempt not found" });
        return sendJson(res, 200, { ok: true, attempt: publicAttempt(attempt) });
      }
      if (p === "/api/federation/invite" && req.method === "GET") {
        // 展示二维码 = 允许被扫到：自动开放监听，但**不再自动接受配对**，
        // 对方扫码发申请后仍需在这里的「新的朋友」确认 SAS（0.4.3 起恢复）。
        const network = await ensureInviteNetworking().catch((error) => ({
          opened: false,
          error: String(error?.message ?? error),
        }));
        const card = federation.contactCard();
        const invite = createInvite({
          card,
          hints: federation.hints,
          name: federation.name,
          publicHost,
        });
        const qr = await QRCode.toDataURL(invite.link, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 360,
          color: { dark: "#0E1110", light: "#FFFFFF" },
        });
        return sendJson(res, 200, {
          ok: true,
          invite: { ...invite, qr, card, network },
        });
      }
      if (p === "/api/federation/peers" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, peers: await peerStore.list() });
      }
      if (p === "/api/federation/grants" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        const grant = String(body?.grant ?? "").trim();
        if (!nodeId || !["tankView", "chat"].includes(grant)) {
          return sendJson(res, 400, { ok: false, error: "nodeId and grant (tankView|chat) required" });
        }
        const peer = await peerStore.setGrant(nodeId, grant, Boolean(body?.value));
        if (!peer) return sendJson(res, 404, { ok: false, error: "peer not found" });
        return sendJson(res, 200, { ok: true, peer });
      }
      if (p === "/api/federation/postcards" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, postcards: await postcardStore.list() });
      }
      if (p === "/api/federation/postcards" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        const character = String(body?.character ?? "").trim();
        const text = String(body?.text ?? "").trim();
        if (!nodeId || !character || !text) {
          return sendJson(res, 400, { ok: false, error: "nodeId, character, text required" });
        }
        const peer = await peerStore.get(nodeId);
        if (!peer) return sendJson(res, 404, { ok: false, error: "peer not found" });
        const postcard = await postcardStore.create({ to: nodeId, character, text });
        let delivery = { local: true, queued: false };
        if (federation.courier) {
          try {
            const envelope = await federation.sendCourier({
              nodeId,
              kind: "postcard",
              payload: { postcard },
            });
            delivery = { local: true, queued: Boolean(envelope), envelopeId: envelope?.id ?? "" };
          } catch (error) {
            delivery = { local: true, queued: false, error: String(error?.message ?? error) };
          }
        }
        return sendJson(res, 200, { ok: true, postcard, delivery });
      }
      if (p === "/api/federation/groups" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, groups: groupStore.list() });
      }
      if (p === "/api/federation/groups" && req.method === "POST") {
        const body = await readJson(req);
        const name = String(body?.name ?? "").trim();
        if (!name) return sendJson(res, 400, { ok: false, error: "name required" });
        const members = [];
        for (const item of body?.members ?? []) {
          const nodeId = String(item?.nodeId ?? item ?? "").trim();
          if (!nodeId) continue;
          const peer = await peerStore.get(nodeId);
          if (!peer) return sendJson(res, 400, { ok: false, error: `peer not found: ${nodeId}` });
          members.push({ nodeId, name: peer.name ?? "" });
        }
        const group = await groupStore.create({ name, members });
        await syncGroup(groupStore.snapshotById(group.id));
        return sendJson(res, 200, { ok: true, group });
      }
      if (p.startsWith("/api/federation/groups/") && req.method === "GET") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length));
        const group = groupStore.get(id);
        if (!group) return sendJson(res, 404, { ok: false, error: "group not found" });
        return sendJson(res, 200, { ok: true, group });
      }
      if (p.startsWith("/api/federation/groups/") && p.endsWith("/messages") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length, -"/messages".length));
        const group = groupStore.get(id);
        if (!group) return sendJson(res, 404, { ok: false, error: "group not found" });
        const body = await readJson(req);
        const text = String(body?.text ?? "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "text required" });
        const self = identity.publicIdentity().nodeId;
        const fromName = nodeName || identity.publicIdentity().fingerprint;
        await groupStore.append(id, { from: self, fromName, text });
        broadcastUi("group", { groupId: id, fromSelf: true });
        const wireGroup = {
          id: group.id,
          name: group.name,
          createdAt: group.createdAt,
          createdBy: group.createdBy,
          members: group.members,
        };
        const deliveries = [];
        for (const member of group.members ?? []) {
          if (!member?.nodeId || member.nodeId === self) continue;
          try {
            const response = await federation.chat(member.nodeId, "group", text, { group: wireGroup });
            deliveries.push({ nodeId: member.nodeId, name: member.name ?? "", ok: true, state: response?.t ?? "sent" });
          } catch (error) {
            // 成员临时掉线：进群补发队列，等他连上自动重发（不是只弹一句"未收到"）
            rememberGroupOutbox(id, member.nodeId, wireGroup, text);
            deliveries.push({ nodeId: member.nodeId, name: member.name ?? "", ok: false, queued: true, error: String(error?.message ?? error) });
          }
        }
        return sendJson(res, 200, { ok: true, group: groupStore.get(id), deliveries });
      }
      if (p.startsWith("/api/federation/groups/") && p.endsWith("/members") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length, -"/members".length));
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        const peer = nodeId ? await peerStore.get(nodeId) : null;
        if (!peer) return sendJson(res, 400, { ok: false, error: "peer not found" });
        const group = await groupStore.addMember(id, { nodeId, name: peer.name ?? "" });
        if (!group) return sendJson(res, 404, { ok: false, error: "group not found" });
        await syncGroup(groupStore.snapshotById(id));
        return sendJson(res, 200, { ok: true, group });
      }
      if (p.startsWith("/api/federation/groups/") && p.endsWith("/members/remove") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length, -"/members/remove".length));
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        const current = groupStore.get(id);
        if (!current) return sendJson(res, 404, { ok: false, error: "group not found" });
        if (current.createdBy !== identity.publicIdentity().nodeId) {
          return sendJson(res, 403, { ok: false, error: "only the group owner can remove members" });
        }
        const oldSnapshot = groupStore.snapshotById(id);
        const result = await groupStore.removeMember(id, nodeId);
        if (!result) return sendJson(res, 404, { ok: false, error: "group not found" });
        const updated = groupStore.snapshotById(id);
        // 规则（BOSS 2026-11-18）：成员少于 3 人，群自动解散
        if (updated && (updated.members ?? []).length < 3) {
          await groupStore.dissolve(id);
          const dissolved = { ...updated, dissolved: true };
          const overrides = {};
          for (const member of updated.members ?? []) overrides[member.nodeId] = dissolved;
          if (nodeId) overrides[nodeId] = { ...updated, dissolved: true, removedFor: nodeId };
          await syncGroup(updated, { extra: nodeId ? [{ nodeId }] : [], overrideByNode: overrides });
          return sendJson(res, 200, { ok: true, dissolved: true, id, reason: "members<3" });
        }
        await syncGroup(updated, {
          extra: nodeId ? [{ nodeId }] : [],
          overrideByNode: nodeId ? { [nodeId]: { ...oldSnapshot, removedFor: nodeId } } : {},
        });
        return sendJson(res, 200, { ok: true, group: groupStore.get(id), removed: result.removed });
      }
      if (p.startsWith("/api/federation/groups/") && p.endsWith("/leave") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length, -"/leave".length));
        const current = groupStore.get(id);
        if (!current) return sendJson(res, 404, { ok: false, error: "group not found" });
        const self = identity.publicIdentity().nodeId;
        if (current.createdBy === self) {
          return sendJson(res, 403, { ok: false, error: "群主不能退出，请解散群聊" });
        }
        if (!(current.members ?? []).some((member) => member.nodeId === self)) {
          return sendJson(res, 404, { ok: false, error: "not a member" });
        }
        await groupStore.removeMember(id, self);
        const remaining = groupStore.snapshotById(id);
        // 规则（BOSS 2026-11-18）：成员少于 3 人，群自动解散（退出后不足 3 人也解散）
        if (!remaining || (remaining.members ?? []).length < 3) {
          const snapshot = remaining ?? groupStore.snapshotById(id);
          await groupStore.dissolve(id);
          if (snapshot) {
            const dissolved = { ...snapshot, dissolved: true };
            const overrides = { [self]: dissolved };
            for (const member of snapshot.members ?? []) overrides[member.nodeId] = dissolved;
            await syncGroup(snapshot, { overrideByNode: overrides });
          }
          return sendJson(res, 200, { ok: true, left: true, dissolved: true, id, reason: "members<3" });
        }
        // 本地先把群从列表里去掉（对端收到的快照里已经没有我）
        await syncGroup(remaining);
        await groupStore.dissolve(id);
        return sendJson(res, 200, { ok: true, left: true, dissolved: false, id });
      }
      if (p.startsWith("/api/federation/groups/") && p.endsWith("/dissolve") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/api/federation/groups/".length, -"/dissolve".length));
        const current = groupStore.get(id);
        if (!current) return sendJson(res, 404, { ok: false, error: "group not found" });
        if (current.createdBy !== identity.publicIdentity().nodeId) {
          return sendJson(res, 403, { ok: false, error: "only the group owner can dissolve" });
        }
        const snapshot = groupStore.snapshotById(id);
        await groupStore.dissolve(id);
        await syncGroup(snapshot, { overrideByNode: Object.fromEntries((snapshot.members ?? []).map((member) => [member.nodeId, { ...snapshot, dissolved: true }])) });
        return sendJson(res, 200, { ok: true, dissolved: true, id });
      }
      if (p === "/api/federation/pending" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, pending: federation.listPendingPairs() });
      }
      if (p === "/api/federation/pending/confirm" && req.method === "POST") {
        const body = await readJson(req);
        const id = String(body?.id ?? "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "id required" });
        const confirmed = federation.confirmPairing(id, body?.accept !== false);
        if (!confirmed) return sendJson(res, 404, { ok: false, error: "pending pairing not found" });
        return sendJson(res, 200, { ok: true, id, accepted: body?.accept !== false });
      }
      if (p === "/api/federation/connect" && req.method === "POST") {
        const body = await readJson(req);
        const autoConfirm = Boolean(body?.autoConfirm);
        if (body?.async === true) {
          const invite = String(body?.invite ?? "").trim();
          const host = String(body?.host ?? "").trim();
          const port = Number(body?.port);
          if (!invite && (!host || !Number.isInteger(port) || port < 1 || port > 65535)) {
            return sendJson(res, 400, { ok: false, error: "invite or host+port required" });
          }
          const attempt = startConnectAttempt({ invite, host, port, autoConfirm });
          return sendJson(res, 200, { ok: true, attempt: publicAttempt(attempt) });
        }
        if (body?.invite) {
          let parsed;
          try {
            parsed = parseInvite(body.invite);
          } catch (error) {
            return sendJson(res, 400, { ok: false, code: "BAD_INVITE", error: String(error?.message ?? error) });
          }
          const tried = [];
          for (const hint of parsed.hints) {
            tried.push(`${hint.host}:${hint.port}`);
            try {
              const session = await federation.connect(hint.host, hint.port, { autoConfirm });
              return sendJson(res, 200, {
                ok: true,
                invite: { nodeId: parsed.nodeId, name: parsed.name },
                tried,
                peer: {
                  nodeId: session.nodeId,
                  name: session.peer.name,
                  sas: session.sas,
                  grants: session.peer.record?.grants ?? {},
                },
              });
            } catch (error) {
              if (error?.code === "PEER_BLOCKED") {
                return sendJson(res, 403, { ok: false, code: "PEER_BLOCKED", error: String(error.message), tried });
              }
            }
          }
          return sendJson(res, 400, { ok: false, code: "CONNECT_FAILED", error: `all hints failed: ${tried.join(", ")}`, tried });
        }
        const host = String(body?.host ?? "").trim();
        const port = Number(body?.port);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          return sendJson(res, 400, { ok: false, error: "host and port required (or invite)" });
        }
        try {
          const session = await federation.connect(host, port, { autoConfirm });
          return sendJson(res, 200, {
            ok: true,
            peer: {
              nodeId: session.nodeId,
              name: session.peer.name,
              sas: session.sas,
              grants: session.peer.record?.grants ?? {},
            },
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: error?.code ?? "CONNECT_FAILED", error: String(error?.message ?? error) });
        }
      }
      if (p === "/api/federation/revoke" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        if (!nodeId) return sendJson(res, 400, { ok: false, error: "nodeId required" });
        const peer = await peerStore.revoke(nodeId);
        federation.disconnect(nodeId);
        return sendJson(res, 200, { ok: true, peer });
      }
      // 删除好友：本地移除联系人 + 删除与 TA 的聊天记录（不通知对方，对方还能再次申请）
      if (p.startsWith("/api/federation/peers/") && req.method === "DELETE") {
        const nodeId = decodeURIComponent(p.slice("/api/federation/peers/".length)).trim();
        if (!nodeId) return sendJson(res, 400, { ok: false, error: "nodeId required" });
        const existed = await peerStore.get(nodeId);
        if (!existed) return sendJson(res, 404, { ok: false, error: "peer not found" });
        try {
          federation.disconnect(nodeId);
        } catch (error) {
          console.log(`[peers] disconnect before delete failed: ${error?.message ?? error}`);
        }
        const human = await humanStore
          .forget(nodeId)
          .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        await peerStore.remove(nodeId);
        return sendJson(res, 200, { ok: true, nodeId, human });
      }
      if (p === "/api/federation/disconnect" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        if (!nodeId) return sendJson(res, 400, { ok: false, error: "nodeId required" });
        return sendJson(res, 200, { ok: true, disconnected: federation.disconnect(nodeId) });
      }
      if (p === "/api/federation/reconnect" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        if (!nodeId) return sendJson(res, 400, { ok: false, error: "nodeId required" });
        const peer = await peerStore.get(nodeId);
        if (!peer) return sendJson(res, 404, { ok: false, error: "peer not found" });
        if (federation.status().sessions.some((session) => session.nodeId === nodeId)) {
          return sendJson(res, 200, { ok: true, already: true, nodeId });
        }
        const order = { lan: 0, tailscale: 1, public: 2, loopback: 3 };
        const hints = (peer.hints ?? [])
          .filter((hint) => hint?.host && hint?.port && hint.host !== "127.0.0.1")
          .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
        const tried = [];
        for (const hint of hints) {
          tried.push(`${hint.host}:${hint.port}`);
          try {
            const session = await federation.connect(hint.host, hint.port, { autoConfirm: false });
            return sendJson(res, 200, { ok: true, tried, peer: { nodeId: session.nodeId, name: session.peer?.name, sas: session.sas } });
          } catch {
            /* 试下一个 hint */
          }
        }
        return sendJson(res, 409, { ok: false, error: "reconnect failed", tried });
      }
      if (p === "/api/federation/chat" && req.method === "POST") {
        const body = await readJson(req);
        const nodeId = String(body?.nodeId ?? "").trim();
        const charId = String(body?.char ?? "").trim();
        const text = String(body?.text ?? "").trim();
        if (!nodeId || !charId || !text) return sendJson(res, 400, { ok: false, error: "nodeId, char, text required" });
        if (text.length > 4000) return sendJson(res, 413, { ok: false, error: "text too long" });
        try {
          const response = await federation.chat(nodeId, charId, text);
          return sendJson(res, 200, { ok: true, response });
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: error?.code ?? "CHAT_FAILED", error: String(error?.message ?? error) });
        }
      }
      if (p === "/api/federation/tank" && req.method === "GET") {
        const nodeId = String(url.searchParams.get("nodeId") ?? "").trim();
        if (!nodeId) return sendJson(res, 400, { ok: false, error: "nodeId required" });
        const tank = federation.remoteTank(nodeId);
        if (!tank) return sendJson(res, 404, { ok: false, error: "no remote tank" });
        return sendJson(res, 200, { ok: true, tank });
      }
      if (p === "/.well-known/vrlink.json" && req.method === "GET") {
        return sendJson(res, 200, {
          name: "vrlink",
          version: "0.0.1",
          protocols: ["http", "sse", "mcp", "a2a"],
          characters: "/v1/characters",
          capabilities: "/v1/capabilities",
          consent: "/v1/consent",
          actions: "/v1/characters/{id}/actions",
          agentCard: "/.well-known/agent.json",
        });
      }
      if (p === "/.well-known/agent.json" && req.method === "GET") {
        return sendJson(res, 200, {
          name: "VRlink",
          description: "一个意识、多个身体的本地多角色运行时；可聊天、控制设备、读写记忆。",
          url: `http://${req.headers.host ?? "127.0.0.1"}`,
          version: "0.0.1",
          capabilities: { streaming: true, pushNotifications: false },
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [
            { id: "chat", name: "与角色聊天", description: "给指定角色发消息，返回她的回复", tags: ["chat", "companion"] },
            { id: "devices", name: "控制设备", description: "列设备、执行低/高风险设备动作（高风险需同意）", tags: ["home", "iot"] },
            { id: "memory", name: "读写记忆", description: "读/写指定角色的长期记忆", tags: ["memory"] },
          ],
        });
      }
      if (p === "/a2a" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          methods: ["message/send", "message/stream", "tasks/get", "tasks/cancel"],
          agentCard: "/.well-known/agent.json",
        });
      }
      if (p === "/a2a" && req.method === "POST") {
        const rpc = await readJson(req);
        const id = rpc?.id ?? null;
        const method = String(rpc?.method ?? "");
        const params = rpc?.params ?? {};
        if (method === "message/send" || method === "message/stream") {
          const parts = Array.isArray(params?.message?.parts) ? params.message.parts : [];
          const text = parts
            .filter((part) => part?.kind === "text" || part?.type === "text")
            .map((part) => part.text ?? part?.data?.text ?? "")
            .join("")
            .trim();
          if (!text) return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "message.parts text required" } });
          if (text.length > 4000) return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "text too long (max 4000)" } });
          const characterId =
            params?.metadata?.characterId ??
            params?.message?.metadata?.characterId ??
            (await store.list())[0]?.id;
          if (!characterId) return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32001, message: "no character" } });
          await store.load(characterId);
          if (method === "message/stream") {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
            });
            const task = await runA2ATask(characterId, text);
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: task })}\n\n`);
            res.write("event: done\ndata: [DONE]\n\n");
            return res.end();
          }
          const task = await runA2ATask(characterId, text);
          return sendJson(res, 200, { jsonrpc: "2.0", id, result: task });
        }
        if (method === "tasks/get") {
          const task = a2aTasks.get(String(params?.id ?? ""));
          if (!task) return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32001, message: "task not found" } });
          return sendJson(res, 200, { jsonrpc: "2.0", id, result: task });
        }
        if (method === "tasks/cancel") {
          const task = a2aTasks.get(String(params?.id ?? ""));
          if (!task) return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32001, message: "task not found" } });
          task.status = { state: "canceled", timestamp: new Date().toISOString() };
          return sendJson(res, 200, { jsonrpc: "2.0", id, result: task });
        }
        return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
      if (p === "/v1/capabilities" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, capabilities: bus.list() });
      }
      if (p === "/v1/characters" && req.method === "GET") {
        const list = await store.list();
        return sendJson(res, 200, {
          ok: true,
          characters: list.map((character) => ({
            id: character.id,
            name: character.name,
            brain: character.brain,
            bodies: character.bodies,
          })),
        });
      }
      const agiAction = p.match(/^\/v1\/characters\/([a-z0-9][a-z0-9_-]{1,40})\/actions$/);
      if (agiAction && req.method === "POST") {
        const characterId = agiAction[1];
        await store.load(characterId);
        const body = await readJson(req);
        const name = String(body?.name ?? "").trim();
        if (!name) return sendJson(res, 400, { ok: false, error: "name required" });
        try {
          const result = await bus.invoke({
            characterId,
            name,
            params: body?.params ?? {},
            reason: String(body?.reason ?? "agi"),
            approvalToken: body?.approvalToken ?? null,
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (error) {
          if (error instanceof ConsentRequiredError && error.detail?.requiresApproval) {
            const ask = await consent.request({
              characterId,
              action: name,
              risk: error.detail.risk,
              reason: String(body?.reason ?? "agi"),
            });
            return sendJson(res, 403, {
              ok: false,
              code: "CONSENT_REQUIRED",
              error: error.message,
              requestId: ask.id,
              detail: error.detail,
            });
          }
          throw error;
        }
      }
      if (p === "/v1/consent" && req.method === "GET") {
        const characterId = url.searchParams.get("characterId");
        return sendJson(res, 200, {
          ok: true,
          grants: consent.list(characterId),
          pending: consent.pendingList(characterId),
        });
      }
      if (p === "/v1/models" && req.method === "GET") {
        const list = await store.list();
        return sendJson(res, 200, {
          object: "list",
          data: list.map((character) => ({
            id: `vrlink:${character.id}`,
            object: "model",
            owned_by: "vrlink",
            name: character.name,
          })),
        });
      }
      if (p === "/v1/chat/completions" && req.method === "POST") {
        const body = await readJson(req);
        const model = String(body?.model ?? "");
        const characterId = model.startsWith("vrlink:") ? model.slice("vrlink:".length) : model;
        if (!characterId) return sendJson(res, 400, { error: { message: "model required" } });
        await store.load(characterId);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const lastUser = [...messages].reverse().find((message) => message?.role === "user");
        const text = String(lastUser?.content ?? "").trim();
        if (!text) return sendJson(res, 400, { error: { message: "last user message required" } });
        if (text.length > 4000) return sendJson(res, 413, { error: { message: "text too long (max 4000)" } });
        const actor = await actors.get(characterId);
        const event = makeEvent({
          characterId,
          type: "message.received",
          body: "api",
          thread: "api",
          actor: { id: "api-client", name: "API" },
          visibility: "private",
          content: { text },
        });
        const result = await actor.enqueue(event);
        const reply = result.produced.find((item) => item.type === "message.sent")?.content?.text ?? "";
        const id = `chatcmpl_${Date.now().toString(36)}`;
        const created = Math.floor(Date.now() / 1000);
        if (body?.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      // 会话列表（给微信式「消息」首页用）：每条鱼最近一条真正收发的消息 + 未读
      // 一键组网：运行时把联邦监听切到 0.0.0.0（或切回本机），邀请 hints 会自动带 LAN/Tailscale 地址
      if (p === "/api/network/lan" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const enabled = body?.enabled !== false;
        const host = enabled ? "0.0.0.0" : "127.0.0.1";
        try {
          const address = await federation.relisten(host);
          try {
            await fs.mkdir(dataDir, { recursive: true });
            await fs.writeFile(
              path.join(dataDir, "network.json"),
              JSON.stringify({ enabled, host, port: address?.port ?? null, updatedAt: Date.now() }, null, 2),
            );
          } catch {
            /* 持久化失败不影响当前会话 */
          }
          return sendJson(res, 200, {
            ok: true,
            enabled,
            federation: address,
            hints: federation.hints,
            note: enabled
              ? "已开放局域网组网：把邀请链接/二维码发给同一 Wi-Fi 或 Tailscale 的朋友；首次连接核对 6 位 SAS。"
              : "已收回为仅本机监听。",
          });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
      // 全局搜索（桌面端 Ctrl+K / 搜索框用）：角色名 + 消息文本
      if (p === "/api/search" && req.method === "GET") {
        const query = String(url.searchParams.get("q") ?? "").trim();
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
        if (!query) return sendJson(res, 200, { ok: true, query: "", characters: [], messages: [] });
        const needle = query.toLowerCase();
        const characters = [];
        const messages = [];
        for (const character of await store.list()) {
          const identity = character.persona?.identity ?? "";
          if (`${character.name} ${character.id} ${identity}`.toLowerCase().includes(needle)) {
            characters.push({ characterId: character.id, name: character.name, identity });
          }
          if (messages.length >= limit) continue;
          const events = await eventLog.read(character.id);
          for (const event of events) {
            if (event.type !== "message.received" && event.type !== "message.sent") continue;
            const text = String(event.content?.text ?? "");
            if (!text.toLowerCase().includes(needle)) continue;
            messages.push({
              characterId: character.id,
              name: character.name,
              fromSelf: event.type === "message.sent",
              text: text.slice(0, 200),
              at: event.at ?? null,
            });
            if (messages.length >= limit) break;
          }
        }
        messages.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        return sendJson(res, 200, { ok: true, query, characters, messages });
      }
      if (p === "/api/conversations" && req.method === "GET") {
        const conversations = [];
        for (const character of await store.list()) {
          const recent = await eventLog.read(character.id, { limit: 40 });
          const messages = recent.filter((event) => event.type === "message.received" || event.type === "message.sent");
          const last = messages[messages.length - 1] ?? null;
          const now = await store.state(character.id);
          conversations.push({
            characterId: character.id,
            name: character.name,
            identity: character.persona?.identity ?? "",
            brain: character.brain?.engine ?? "mock",
            unread: Number(now?.unread ?? 0),
            eventCount: Number(now?.eventCount ?? recent.length),
            last: last
              ? {
                  type: last.type,
                  fromSelf: last.type === "message.sent",
                  text: String(last.content?.text ?? "").slice(0, 160),
                  at: last.at ?? null,
                }
              : null,
            updatedAt: now?.updatedAt ?? character.updatedAt ?? null,
          });
        }
        conversations.sort((a, b) => (b.last?.at ?? b.updatedAt ?? 0) - (a.last?.at ?? a.updatedAt ?? 0));
        return sendJson(res, 200, { ok: true, conversations });
      }
      if (p === "/api/characters" && req.method === "GET") {
        const list = await store.list();
        const withState = [];
        for (const character of list) withState.push({ ...character, state: await store.state(character.id) });
        return sendJson(res, 200, { ok: true, characters: withState });
      }
      if (p === "/api/characters" && req.method === "POST") {
        const body = await readJson(req);
        const engine = String(body?.brain?.engine ?? "mock");
        if ((engine === "api" || engine === "openai") && !cloudApiAllowed()) {
          return sendJson(res, 403, { ok: false, error: CLOUD_API_BLOCKED, edition: EDITION });
        }
        const character = await store.create(body ?? {});
        await identity.ensureCharacter(character.id, { name: character.name });
        await ensureDefaultGrant(character.id, "owner");
        // 建鱼后主动推 profile：对端不用重连就能在远端鱼缸看到（2026-11-08 两机复验发现）
        await federation.broadcastProfile().catch(() => {});
        return sendJson(res, 201, { ok: true, character });
      }

      const match = p.match(/^\/api\/characters\/([a-z0-9][a-z0-9_-]{1,40})(?:\/([a-z-]+))?$/);
      if (match) {
        const characterId = match[1];
        const action = match[2] ?? "";
        await store.load(characterId);

        if (!action && req.method === "GET") {
          return sendJson(res, 200, { ok: true, character: await store.load(characterId), state: await store.state(characterId) });
        }
        if (action === "identity" && req.method === "GET") {
          return sendJson(res, 200, { ok: true, identity: await identity.publicCharacter(characterId) });
        }
        if (action === "verify" && req.method === "GET") {
          const events = await eventLog.read(characterId);
          const verification = await identity.verifyChain(characterId, events);
          return sendJson(res, 200, { ok: true, verified: verification.ok, verification });
        }
        if (action === "budget" && req.method === "PATCH") {
          const body = await readJson(req);
          const current = await store.load(characterId);
          const nextBudget = { ...(current.budget ?? {}) };          for (const key of ["turnsPerDay", "tokensPerDay", "costPerDay"]) {
            if (body?.[key] === undefined) continue;
            if (body[key] === null) {
              nextBudget[key] = null;
              continue;
            }
            const value = Number(body[key]);
            if (!Number.isFinite(value) || value < 0) return sendJson(res, 400, { ok: false, error: `${key} must be a non-negative number or null` });
            nextBudget[key] = value;
          }
          if (body?.overLimit !== undefined) {
            if (!["warn", "mute", "stop"].includes(body.overLimit)) return sendJson(res, 400, { ok: false, error: "overLimit must be warn/mute/stop" });
            nextBudget.overLimit = body.overLimit;
          }
          if (!nextBudget.overLimit) nextBudget.overLimit = "warn";
          current.budget = nextBudget;
          const saved = await store.save(current);
          actors.invalidate(characterId);
          return sendJson(res, 200, { ok: true, character: saved, budget: saved.budget });
        }
        if (action === "brain" && req.method === "PATCH") {
          const body = await readJson(req);
          const current = await store.load(characterId);
          const engine = String(body?.engine ?? current.brain?.engine ?? "mock");
          if (!["mock", "api", "local", "auto"].includes(engine)) {
            return sendJson(res, 400, { ok: false, error: "engine must be mock/api/local/auto" });
          }
          if ((engine === "api" || engine === "openai") && !cloudApiAllowed()) {
            return sendJson(res, 403, { ok: false, error: CLOUD_API_BLOCKED, edition: EDITION });
          }
          const next = { ...(current.brain ?? {}), engine };
          if (body?.model !== undefined) next.model = String(body.model).slice(0, 120);
          if (body?.temperature !== undefined) {
            const temperature = Number(body.temperature);
            if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
              return sendJson(res, 400, { ok: false, error: "temperature must be 0..2" });
            }
            next.temperature = temperature;
          }
          current.brain = next;
          const saved = await store.save(current);
          actors.invalidate(characterId);
          return sendJson(res, 200, { ok: true, character: saved, brain: saved.brain });
        }
        if (action === "events" && req.method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return sendJson(res, 200, { ok: true, events: await eventLog.read(characterId, { limit }) });
        }
        if (action === "replay" && req.method === "GET") {
          const events = await eventLog.read(characterId);
          const types = {};
          for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1;
          return sendJson(res, 200, {
            ok: true,
            characterId,
            eventCount: events.length,
            firstAt: events[0]?.at ?? null,
            lastAt: events[events.length - 1]?.at ?? null,
            types,
          });
        }
        if (action === "recover" && req.method === "POST") {
          const events = await eventLog.read(characterId);
          const state = await store.state(characterId);
          const rebuilt = rebuildStateFromEvents(events, state ?? {});
          await store.updateState(characterId, rebuilt);
          return sendJson(res, 200, { ok: true, state: rebuilt });
        }
        if (action === "snapshot" && req.method === "POST") {
          return sendJson(res, 200, await store.snapshot(characterId));
        }
        if (action === "snapshots" && req.method === "GET") {
          return sendJson(res, 200, { ok: true, snapshots: await store.snapshots(characterId) });
        }
        if (action === "events" && req.method === "POST") {
          const body = await readJson(req);
          const actor = await actors.get(characterId);
          const result = await actor.enqueue({ ...body, characterId });
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "simulate" && req.method === "POST") {
          const body = await readJson(req);
          const text = String(body?.text ?? "").trim();
          if (!text) return sendJson(res, 400, { ok: false, error: "text required" });
          if (text.length > 4000) return sendJson(res, 413, { ok: false, error: "text too long (max 4000)" });
          const event = makeEvent({
            characterId,
            type: "message.received",
            body: String(body?.body ?? "qq"),
            thread: String(body?.thread ?? "group:demo"),
            actor: body?.actor ?? { id: "demo_user", name: "演示用户" },
            visibility: body?.visibility ?? "group",
            content: { text },
          });
          const actor = await actors.get(characterId);
          const result = await actor.enqueue(event);
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "draft" && req.method === "POST") {
          const body = await readJson(req);
          const text = String(body?.text ?? "").trim();
          if (!text) return sendJson(res, 400, { ok: false, error: "text required" });
          if (text.length > 4000) return sendJson(res, 413, { ok: false, error: "text too long (max 4000)" });
          const event = makeEvent({
            characterId,
            type: "message.received",
            body: String(body?.body ?? "bili"),
            thread: String(body?.thread ?? "bili:comment"),
            actor: body?.actor ?? { id: "bili_user", name: "B站用户" },
            visibility: body?.visibility ?? "public",
            content: { text, draft: true },
          });
          const actor = await actors.get(characterId);
          const result = await actor.enqueue(event);
          const draft = result.produced.find((item) => item.type === "message.draft")?.content?.text ?? "";
          return sendJson(res, 200, { ok: true, draft, produced: result.produced });
        }
        if (action === "chat" && req.method === "POST") {
          if (emergencyStop) return sendJson(res, 503, { ok: false, error: "emergency stop is on" });
          const body = await readJson(req);
          const text = String(body?.text ?? "").trim();
          if (!text) return sendJson(res, 400, { ok: false, error: "text required" });
          if (text.length > 4000) return sendJson(res, 413, { ok: false, error: "text too long (max 4000)" });
          const event = makeEvent({
            characterId,
            type: "message.received",
            body: "desktop",
            thread: "main",
            actor: { id: "owner", name: "我" },
            visibility: body?.visibility ?? "private",
            content: { text },
          });
          const actor = await actors.get(characterId);
          const result = await actor.enqueue(event);
          const reply = result.produced.find((item) => item.type === "message.sent");
          return sendJson(res, 200, { ok: true, reply: reply?.content?.text ?? "", produced: result.produced });
        }
        if (action === "stream" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write("retry: 1000\n\n");
          const initial = await eventLog.read(characterId, { limit: 50 });
          res.write(`event: snapshot\ndata: ${JSON.stringify({ events: initial })}\n\n`);
          const set = sse.get(characterId) ?? new Set();
          set.add(res);
          sse.set(characterId, set);
          const heartbeat = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              /* ignore */
            }
          }, 20000);
          req.on("close", () => {
            clearInterval(heartbeat);
            set.delete(res);
          });
          return;
        }
        if (action === "memory" && req.method === "GET") {
          return sendJson(res, 200, { ok: true, memory: await store.listMemory(characterId, { limit: Number(url.searchParams.get("limit") ?? 100) }) });
        }
        return sendJson(res, 404, { ok: false, error: "not found" });
      }

      if (p === "/api/capabilities" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, capabilities: bus.list() });
      }
      if (p === "/api/scheduler" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, scheduler: scheduler.status() });
      }
      if (p === "/api/overview" && req.method === "GET") {
        const list = await store.list();
        const schedulerStatus = scheduler.status();
        const characters = [];
        let todayTokens = 0;
        for (const character of list) {
          const state = await store.state(character.id);
          todayTokens += Number(state?.usage?.tokens ?? 0);
          characters.push({
            id: character.id,
            name: character.name,
            brain: character.brain,
            budget: character.budget ?? null,
            state,
            queuePosition: queuePositionFor(schedulerStatus, character.id),
          });
        }
        return sendJson(res, 200, {
          ok: true,
          characters,
          scheduler: schedulerStatus,
          safeMode,
          homeSource: process.env.VRLINK_HA_URL ? "home-assistant" : "virtual",
          deviceCount: home.list().length,
          pluginCount: pluginHost.list().length,
          todayTokens,
          todayCost: 0,
        });
      }
      if (p === "/api/devices" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, devices: home.list() });
      }
      if (p === "/api/home/status" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          source: process.env.VRLINK_HA_URL ? "home-assistant" : "virtual",
          deviceCount: home.list().length,
        });
      }
      if (p === "/api/connections" && req.method === "GET") {
        const [onebot, bili] = await Promise.all([probeHealth(onebotHealthUrl), probeHealth(biliHealthUrl)]);
        return sendJson(res, 200, {
          ok: true,
          home: { source: process.env.VRLINK_HA_URL ? "home-assistant" : "virtual", deviceCount: home.list().length },
          onebot: { url: onebotHealthUrl, online: onebot },
          bili: { url: biliHealthUrl, online: bili, mode: "draft-only" },
          mcp: { command: "npm run mcp" },
          acp: { command: "npm run acp" },
        });
      }
      const deviceCommand = p.match(/^\/api\/devices\/([a-z0-9][a-z0-9_.-]{1,80})\/command$/);
      if (deviceCommand && req.method === "POST") {
        if (safeMode) return sendJson(res, 503, { ok: false, error: "safe mode blocks device actions" });
        const body = await readJson(req);
        const characterId = String(body?.characterId ?? "").trim();
        if (!characterId) return sendJson(res, 400, { ok: false, error: "characterId required" });
        try {
          const result = await bus.invoke({
            characterId,
            name: "device.command",
            params: {
              deviceId: deviceCommand[1],
              command: String(body?.command ?? ""),
              args: body?.args ?? {},
            },
            reason: String(body?.reason ?? "manual device command"),
            approvalToken: body?.approvalToken ?? null,
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (error) {
          if (error instanceof ConsentRequiredError && error.detail?.requiresApproval) {
            const ask = await consent.request({
              characterId,
              action: "device.command",
              risk: error.detail.risk,
              reason: `${deviceCommand[1]} ${String(body?.command ?? "")}`,
            });
            return sendJson(res, 403, {
              ok: false,
              code: "CONSENT_REQUIRED",
              error: error.message,
              requestId: ask.id,
              detail: error.detail,
            });
          }
          throw error;
        }
      }
      if (p === "/api/plugins" && req.method === "GET") {
        const plugins = pluginHost.list();
        return sendJson(res, 200, {
          ok: true,
          plugins: plugins.map((item) => ({
            ...item,
            permissionInfo: describePermissions(item),
          })),
        });
      }
      const pluginAction = p.match(/^\/api\/plugins\/([a-z0-9][a-z0-9_-]{1,40})\/(enable|disable)$/);
      if (pluginAction && req.method === "POST") {
        const result = pluginAction[2] === "enable" ? await pluginHost.enable(pluginAction[1]) : await pluginHost.disable(pluginAction[1]);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      const pluginPermissions = p.match(/^\/api\/plugins\/([a-z0-9][a-z0-9_-]{1,40})\/permissions$/);
      if (pluginPermissions && req.method === "GET") {
        const permissions = pluginHost.getPermissions(pluginPermissions[1]);
        if (!permissions) return sendJson(res, 404, { ok: false, error: "unknown plugin" });
        return sendJson(res, 200, { ok: true, ...permissions });
      }
      if (pluginPermissions && req.method === "PUT") {
        const body = await readJson(req);
        const result = await pluginHost.setPermissions(pluginPermissions[1], body?.permissions);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      const pluginStorage = p.match(/^\/api\/plugins\/([a-z0-9][a-z0-9_-]{1,40})\/storage$/);
      if (pluginStorage && req.method === "GET") {
        const data = await pluginHost.exportStorage(pluginStorage[1]);
        if (!data) return sendJson(res, 404, { ok: false, error: "unknown plugin" });
        return sendJson(res, 200, { ok: true, data });
      }
      if (pluginStorage && req.method === "DELETE") {
        return sendJson(res, 200, await pluginHost.purgeStorage(pluginStorage[1]));
      }
      if (p === "/api/import" && req.method === "POST") {
        const body = await readJson(req);        const soulText = String(body?.soulText ?? "").slice(0, 200000);
        const importEngine = String(body?.brain?.engine ?? "mock");
        if ((importEngine === "api" || importEngine === "openai") && !cloudApiAllowed()) {
          return sendJson(res, 403, { ok: false, error: CLOUD_API_BLOCKED, edition: EDITION });
        }
        const memoryText = String(body?.memoryText ?? "").slice(0, 500000);
        const name = String(body?.name ?? "").trim() || parseSoulName(soulText) || "导入的 Agent";
        const identity = parseSoulIdentity(soulText) || "从 SOUL.md 导入";
        const character = await store.create({
          id: body?.id,
          name,
          persona: { identity, baseline: "从 SOUL.md / 记忆文件导入", soul: soulText.slice(0, 20000) },
          brain: body?.brain ?? { engine: "mock", model: "mock" },
        });
        await ensureDefaultGrant(character.id, "import");
        const lines = memoryText
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .slice(0, 500);
        let importedMemories = 0;
        for (const line of lines) {
          await store.appendMemory(character.id, {
            text: line.slice(0, 1000),
            source: "import:soul",
            visibility: "private",
            confidence: 0.6,
          });
          importedMemories += 1;
        }
        return sendJson(res, 201, { ok: true, character, importedMemories });
      }
      if (p === "/api/import/dshpet" && req.method === "POST") {
        const body = await readJson(req, 48 * 1024 * 1024);
        const raw = String(body?.data ?? "").replace(/^data:[^;]+;base64,/, "");
        if (!raw) return sendJson(res, 400, { ok: false, error: "data (base64) required" });
        const buffer = Buffer.from(raw, "base64");
        if (!buffer.length) return sendJson(res, 400, { ok: false, error: "empty data" });
        const result = await importDshpet({ buffer, store });
        return sendJson(res, 201, {
          ok: true,
          character: result.character,
          sourceId: result.sourceId,
          name: result.name,
          files: result.files,
          animations: result.animations,
          assets: result.assets,
        });
      }
      if (p === "/api/safe-mode" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, safeMode });
      }
      if (p === "/api/safe-mode" && req.method === "POST") {
        safeMode = true;
        const disabled = await pluginHost.disableAll();
        return sendJson(res, 200, { ok: true, safeMode, ...disabled });
      }
      if (p === "/api/safe-mode/off" && req.method === "POST") {
        safeMode = false;
        return sendJson(res, 200, { ok: true, safeMode });
      }
      if (p === "/api/consent" && req.method === "GET") {
        const characterId = url.searchParams.get("characterId");
        return sendJson(res, 200, {
          ok: true,
          grants: consent.list(characterId),
          pending: consent.pendingList(characterId),
        });
      }
      if (p === "/api/consent" && req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, { ok: true, grant: await consent.grant(body ?? {}) });
      }
      const revoke = p.match(/^\/api\/consent\/([a-z0-9_-]+)\/revoke$/);
      if (revoke && req.method === "POST") {
        return sendJson(res, 200, { ok: true, ...(await consent.revoke(revoke[1])) });
      }
      const approve = p.match(/^\/api\/consent\/requests\/([a-z0-9_-]+)\/approve$/);
      if (approve && req.method === "POST") {
        return sendJson(res, 200, { ok: true, grant: await consent.approve(approve[1]) });
      }
      const reject = p.match(/^\/api\/consent\/requests\/([a-z0-9_-]+)\/reject$/);
      if (reject && req.method === "POST") {
        return sendJson(res, 200, { ok: true, ...(await consent.reject(reject[1])) });
      }
      if (p === "/api/audit" && req.method === "GET") {
        const characterId = url.searchParams.get("characterId");
        if (!characterId) return sendJson(res, 400, { ok: false, error: "characterId required" });
        return sendJson(res, 200, { ok: true, audit: await audit.list(characterId, { limit: Number(url.searchParams.get("limit") ?? 100) }) });
      }
      if (p === "/api/emergency-stop" && req.method === "POST") {
        emergencyStop = true;
        return sendJson(res, 200, { ok: true, emergencyStop });
      }
      if (p === "/api/resume" && req.method === "POST") {
        emergencyStop = false;
        return sendJson(res, 200, { ok: true, emergencyStop });
      }
      if (p === "/api/emergency-stop" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, emergencyStop });
      }

      if (req.method === "GET") {
        if (p === "/" || p === "/index.html") {
          // 只保留当前分层式界面；旧版页面已下线（合规考虑，发布包里不再带旧文案）。
          return serveFile(res, path.join(uiDir, "wx.html"));
        }
        if (p.startsWith("/guest/")) return serveFile(res, path.join(uiDir, "guest.html"));
        if (p === "/guest.js") return serveFile(res, path.join(uiDir, "guest.js"));
        if (p === "/wx") return serveFile(res, path.join(uiDir, "wx.html"));
        if (p === "/wx.js") return serveFile(res, path.join(uiDir, "wx.js"));
        if (p === "/wx.css") return serveFile(res, path.join(uiDir, "wx.css"));
        if (p.startsWith("/vendor/")) {
          const name = p.slice("/vendor/".length);
          if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
            return sendJson(res, 400, { ok: false, error: "bad vendor path" });
          }
          return serveFile(res, path.join(uiDir, "vendor", name));
        }
        // 界面音效：/sfx/vrlink-sfx.js、/sfx/sounds/*.wav（允许一层子目录，禁穿越）
        if (p.startsWith("/sfx/")) {
          const rel = p.slice("/sfx/".length);
          if (!rel || rel.includes("..") || rel.includes("\\") || path.isAbsolute(rel)) {
            return sendJson(res, 400, { ok: false, error: "bad sfx path" });
          }
          return serveFile(res, path.join(uiDir, "sfx", rel));
        }
        if (p === "/logo-a.svg") return serveFile(res, path.join(uiDir, "logo-a.svg"));
        if (p === "/logo-b.svg") return serveFile(res, path.join(uiDir, "logo-b.svg"));
        if (p === "/logo-c.svg") return serveFile(res, path.join(uiDir, "logo-c.svg"));
        if (p === "/logo-orca-line.svg") return serveFile(res, path.join(uiDir, "logo-orca-line.svg"));
        if (p === "/icon.png") return serveFile(res, path.join(uiDir, "icon.png"));
      }
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      if (error instanceof ConsentRequiredError) {
        return sendJson(res, 403, { ok: false, code: error.code, error: error.message, detail: error.detail });
      }
      if (error instanceof BudgetExceededError) {
        return sendJson(res, 429, { ok: false, code: error.code, error: error.message, detail: error.detail });
      }
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  attachWebSocket(server, eventLog);

  // HTTP 关掉后停止重连循环，否则测试进程/退出阶段还会留一个定时器（Windows 上会在退出时触发 libuv 断言）
  server.on("close", () => {
    clearInterval(reconnectTimer);
  });

  return { server, store, eventLog, identity, peerStore, postcardStore, groupStore, guestTokens, humanStore, federation, courier, consent, audit, bus, actors, pluginHost, home, scheduler, a2aTasks, dataDir, pluginsDir, token };
}

function authorized(req, url, token) {
  if (!token) return true;
  const header = String(req.headers.authorization ?? "");
  return header === `Bearer ${token}` || url.searchParams.get("token") === token;
}

async function probeHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function parseSoulName(text) {  const match = String(text ?? "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim().slice(0, 24) : "";
}

function parseSoulIdentity(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("---"));
  return lines[0]?.slice(0, 80) ?? "";
}

function queuePositionFor(status, characterId) {  for (const group of ["api", "local"]) {
    const queued = status?.[group]?.queued ?? [];
    const index = queued.findIndex((item) => item.characterId === characterId);
    if (index >= 0) return { group, position: index + 1 };
  }
  return null;
}

async function createHomeAdapter(options = {}) {  const baseUrl = process.env.VRLINK_HA_URL;
  const token = process.env.VRLINK_HA_TOKEN;
  const seedDemo = options.homeDemo === true || process.env.VRLINK_HOME_DEMO === "1";
  if (!baseUrl) return new VirtualHome({ seedDemo });
  try {
    const adapter = await new HomeAssistantAdapter({ baseUrl, token }).init();
    console.log(`[home] Home Assistant connected: ${adapter.list().length} devices`);
    return adapter;
  } catch (error) {
    console.warn(`[home] Home Assistant unavailable, using virtual home: ${error?.message ?? error}`);
    return new VirtualHome({ seedDemo });
  }
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveFile(res, file) {
  try {
    const body = await fs.readFile(file);
    const ext = path.extname(file);
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

export async function start(options = {}) {
  const federationPort =
    options.federationPort ?? (process.env.VRLINK_FEDERATION_PORT ? Number(process.env.VRLINK_FEDERATION_PORT) : 5275);
  const hub = await createHub({ ...options, federationPort });
  const port = Number(options.port ?? process.env.VRLINK_V2_PORT ?? 5274);
  const host = options.host ?? process.env.VRLINK_V2_HOST ?? "127.0.0.1";
  await new Promise((resolve, reject) => {
    hub.server.once("error", reject);
    hub.server.listen(port, host, resolve);
  });
  const address = hub.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`VRlink v2 listening on http://${host}:${actualPort}`);
  if (hub.federation?.listenAddress) {
    console.log(
      `VRlink federation on tcp://${hub.federation.listenAddress.host}:${hub.federation.listenAddress.port}`,
    );
  }
  return { ...hub, port: actualPort, host };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

