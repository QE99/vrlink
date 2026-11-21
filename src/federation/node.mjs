import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function hintType(host) {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "loopback";
  const match = String(host).match(/^(\d+)\.(\d+)\./);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return "lan";
  }
  return "public";
}

function buildHints(host, port) {
  const out = [];
  const add = (value, type = hintType(value), targetPort = port) => {
    if (!value || out.some((item) => item.host === value && item.port === targetPort)) return;
    out.push({ type, host: value, port: targetPort });
  };
  if (host !== "0.0.0.0" && host !== "::" && host !== "[::]") add(host);
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal) add(entry.address);
      }
    }
    add("127.0.0.1", "loopback");
  }
  const extra = String(process.env.VRLINK_FEDERATION_HINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of extra) {
    const index = value.lastIndexOf(":");
    if (index < 1) continue;
    const extraHost = value.slice(0, index).trim();
    const extraPort = Number(value.slice(index + 1));
    if (extraHost && Number.isInteger(extraPort) && extraPort > 0 && extraPort <= 65535) add(extraHost, hintType(extraHost), extraPort);
  }
  return out.length ? out : [{ type: "tcp", host, port }];
}

import { verifyCertifiedEvent, verifyCharacterCertificate, verifyNodeCertificate } from "./identity.mjs";
import { isSignedEvent } from "./events.mjs";
import { establishPeer, performHandshake } from "./session.mjs";
import { FrameStream } from "./wire.mjs";

const DEFAULT_CAPS = ["events.v1", "chat.v1", "human.v1", "pair.sync.v1"];
const MAX_TEXT = 4000;

function requestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * One federation node: listens for peers, dials peers, pairs, syncs signed
 * events, and carries chat to another node's characters.
 *
 * M1 deliberately keeps remote data in an in-memory mirror. Persistent remote
 * replication belongs to M2/M3.
 */
export class FederationNode extends EventEmitter {
  constructor({
    identity,
    eventLog,
    store,
    peerStore,
    name = "",
    caps = DEFAULT_CAPS,
    autoConfirm = false,
    onPair = null,
    onChat = null,
    onGroup = null,
    onHuman = null,
    humanCard = null,
    courier = null,
    courierPollMs = 15000,
    dataDir = "",
    log = () => {},
  } = {}) {
    super();
    if (!identity) throw new Error("FederationNode: identity required");
    if (!eventLog) throw new Error("FederationNode: eventLog required");
    if (!store) throw new Error("FederationNode: store required");
    this.identity = identity;
    this.eventLog = eventLog;
    this.store = store;
    if (!peerStore) throw new Error("FederationNode: peerStore required");
    this.peerStore = peerStore;
    this.courier = courier;
    this.courierPollMs = Math.max(500, Number(courierPollMs) || 15000);
    this.courierTimer = null;
    this.dataDir = dataDir ? path.resolve(dataDir) : "";
    this.remoteDir = this.dataDir ? path.join(this.dataDir, "federation", "remote") : "";
    this.persistTimers = new Map();
    this.name = String(name || identity.publicIdentity().fingerprint).slice(0, 80);
    this.caps = Array.isArray(caps) ? caps : DEFAULT_CAPS;
    this.autoConfirm = Boolean(autoConfirm);
    this.onPair = onPair;
    this.pairHandler = onPair
      ? async (info) => Boolean(await onPair(info))
      : async (info) => this.#requestPairing(info);
    this.pendingPairs = new Map();
    this.pairTimeoutMs = 120000;
    this.autoAcceptUntil = 0;
    this.onChat = onChat;
    this.onGroup = onGroup;
    this.onHuman = onHuman;
    this.humanCard = humanCard;
    this.log = log;
    this.server = null;
    this.hints = [];
    this.sessions = new Map();
    this.remote = new Map();
    this.closed = false;
    this.onLocalEvent = (event) => this.#broadcast(event);
    this.eventLog.on("event", this.onLocalEvent);
  }

  async init() {
    await this.peerStore.init();
    await this.#loadRemote();
    this.#startCourierPolling();
    return this;
  }

  #startCourierPolling() {
    if (!this.courier || this.courierTimer) return;
    this.courierTimer = setInterval(() => {
      this.pollCourier().catch((error) => this.log(`[federation] courier poll failed: ${error?.message ?? error}`));
    }, this.courierPollMs);
    this.courierTimer.unref?.();
    this.pollCourier().catch((error) => this.log(`[federation] courier poll failed: ${error?.message ?? error}`));
  }

  #remoteFile(nodeId) {
    if (!this.remoteDir) return "";
    const name = crypto.createHash("sha256").update(String(nodeId)).digest("hex").slice(0, 24);
    return path.join(this.remoteDir, `${name}.json`);
  }

  async #loadRemote() {
    if (!this.remoteDir) return;
    await fs.mkdir(this.remoteDir, { recursive: true });
    let files = [];
    try {
      files = await fs.readdir(this.remoteDir);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const saved = JSON.parse(await fs.readFile(path.join(this.remoteDir, file), "utf8"));
        if (!saved?.peer?.nodeId || !verifyNodeCertificate(saved.peer.nodeCert)) continue;
        const chars = new Map();
        for (const cert of saved.chars ?? []) {
          if (verifyCharacterCertificate(cert, saved.peer.nodeCert)) chars.set(cert.char, cert);
        }
        const events = new Map();
        for (const [char, list] of Object.entries(saved.events ?? {})) {
          const cert = chars.get(char);
          if (!cert) continue;
          const bucket = new Map();
          for (const event of list ?? []) {
            if (verifyCertifiedEvent(event, cert, saved.peer.nodeCert).ok) bucket.set(event.seq, event);
          }
          events.set(char, bucket);
        }
        const state = {
          peer: saved.peer,
          profile: saved.profile ?? null,
          chars,
          heads: new Map((saved.heads ?? []).map((head) => [head.char, head])),
          events,
        };
        this.remote.set(saved.peer.nodeId, state);
      } catch (error) {
        this.log(`[federation] remote cache ignored ${file}: ${error?.message ?? error}`);
      }
    }
  }

  #schedulePersist(state) {
    if (!this.remoteDir || !state?.peer?.nodeId) return;
    const nodeId = state.peer.nodeId;
    const previous = this.persistTimers.get(nodeId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.persistTimers.delete(nodeId);
      this.#persistRemote(state).catch((error) =>
        this.log(`[federation] remote persist failed: ${error?.message ?? error}`),
      );
    }, 80);
    timer.unref?.();
    this.persistTimers.set(nodeId, timer);
  }

  async #persistRemote(state) {
    const file = this.#remoteFile(state.peer.nodeId);
    if (!file) return;
    await fs.mkdir(this.remoteDir, { recursive: true });
    const payload = {
      v: 1,
      peer: state.peer,
      profile: state.profile,
      chars: [...state.chars.values()],
      heads: [...state.heads.values()],
      events: Object.fromEntries(
        [...state.events.entries()].map(([char, map]) => [
          char,
          [...map.values()].sort((a, b) => a.seq - b.seq),
        ]),
      ),
      savedAt: Date.now(),
    };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async listen(port = 5275, host = "127.0.0.1") {
    if (this.server) throw new Error("FederationNode already listening");
    await this.init();
    this.server = net.createServer((socket) => {
      this.#accept(socket).catch((error) => {
        this.log(`[federation] accept failed: ${error?.message ?? error}`);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    this.listenAddress = { host, port: actualPort };
    this.hints = buildHints(host, actualPort);
    return this.listenAddress;
  }

  async close() {
    this.closed = true;
    if (this.courierTimer) {
      clearInterval(this.courierTimer);
      this.courierTimer = null;
    }
    this.eventLog.off("event", this.onLocalEvent);    for (const session of this.sessions.values()) {
      try {
        session.channel.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const state of this.remote.values()) {
      await this.#persistRemote(state).catch(() => {});
    }
    for (const pending of this.pendingPairs.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error("federation node closed"), { code: "NODE_CLOSED" }));
    }
    this.pendingPairs.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  /**
   * 运行时切换联邦监听地址（一键组网用）。
   * 不改变端口；会断开现有会话（对端重连即可），然后按新 host 重新监听，
   * hints 会按新 host 重新生成（0.0.0.0 → 枚举所有网卡，邀请里带 LAN/Tailscale 地址）。
   */
  async relisten(host = "127.0.0.1") {
    const port = this.listenAddress?.port ?? 5275;
    await this.close();
    this.closed = false;
    this.eventLog.on("event", this.onLocalEvent);
    return this.listen(port, host);
  }

  contactCard({ expiresAt = Date.now() + 7 * 86400_000 } = {}) {
    const body = {
      v: 1,
      node: this.identity.publicIdentity(),
      name: this.name,
      hints: this.hints,
      issuedAt: Date.now(),
      expiresAt,
    };
    return { ...body, sig: this.identity.signDetached(body) };
  }

  async connect(host, port, { autoConfirm = this.autoConfirm, name = this.name, pairTimeoutMs = 0, timeoutMs = 10000 } = {}) {
    await this.init();
    const stream = await FrameStream.connect({ host, port, timeoutMs });
    let handshake;
    try {
      handshake = await performHandshake({
        stream,
        identity: this.identity,
        role: "initiator",
        name,
        hints: this.hints,
        caps: this.caps,
      });
      const record = await establishPeer({
        channel: handshake.channel,
        identity: this.identity,
        role: "initiator",
        peer: handshake.peer,
        sas: handshake.sas,
        peerStore: this.peerStore,
        name,
        caps: this.caps,
        autoConfirm,
        onPair: this.pairHandler,
        // 扫码加入时对方可能在几十秒后才确认 SAS，默认 10s 太短
        ...(pairTimeoutMs > 0 ? { timeoutMs: pairTimeoutMs } : {}),
      });
      return this.#startSession({
        role: "initiator",
        peer: handshake.peer,
        record,
        sas: handshake.sas,
        channel: handshake.channel,
      });
    } catch (error) {
      try {
        handshake?.channel?.close();
        stream.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  async #accept(socket) {
    const stream = FrameStream.fromSocket(socket);
    let handshake;
    try {
      handshake = await performHandshake({
        stream,
        identity: this.identity,
        role: "responder",
        name: this.name,
        hints: this.hints,
        caps: this.caps,
      });
      const record = await establishPeer({
        channel: handshake.channel,
        identity: this.identity,
        role: "responder",
        peer: handshake.peer,
        sas: handshake.sas,
        peerStore: this.peerStore,
        name: this.name,
        caps: this.caps,
        autoConfirm: this.autoConfirm,
        onPair: this.pairHandler,
      });
      return this.#startSession({
        role: "responder",
        peer: handshake.peer,
        record,
        sas: handshake.sas,
        channel: handshake.channel,
      });
    } catch (error) {
      try {
        handshake?.channel?.close();
        stream.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  #requestPairing({ sas, peer }) {
    if (this.autoConfirm) return Promise.resolve(true);
    // 同一个节点每次自动重连都会重新发一次配对请求；不去重的话「新的朋友」会越堆越多
    //（2026-11-18 实测：MateBook / 局域网节点各重试 3 次，徽标 2→4→6→8）。
    if (peer?.nodeId) {
      for (const [oldId, old] of this.pendingPairs) {
        if (old.peer?.nodeId !== peer.nodeId) continue;
        this.pendingPairs.delete(oldId);
        if (old.timer) clearTimeout(old.timer);
        old.resolve(false); // 旧连接当作「被新请求取代」，避免握手悬空
      }
    }
    const id = `pair_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        sas,
        peer: {
          nodeId: peer.nodeId,
          name: peer.name,
          hints: peer.hints,
          nodeCert: peer.nodeCert,
        },
        createdAt: Date.now(),
        resolve,
        reject,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        this.pendingPairs.delete(id);
        reject(Object.assign(new Error("federation pairing timed out"), { code: "PAIR_TIMEOUT" }));
      }, this.pairTimeoutMs);
      pending.timer.unref?.();
      this.pendingPairs.set(id, pending);
      this.emit("pair-request", this.listPendingPairs().find((item) => item.id === id));
      this.log(`[federation] pairing request ${id}: SAS ${sas} from ${peer.nodeId} (${peer.name})`);
    });
  }

  /**
   * 邀请窗口：在接下来 ms 毫秒内收到的配对请求直接接受。
   * 语义：对方主动展示邀请二维码 = 同意被加，不需要再跑去「新的朋友」确认。
   */
  openInviteWindow(ms = 10 * 60 * 1000) {
    this.autoAcceptUntil = Date.now() + Math.max(1000, Number(ms) || 0);
    return this.autoAcceptUntil;
  }

  listPendingPairs() {    return [...this.pendingPairs.values()].map((pending) => ({
      id: pending.id,
      sas: pending.sas,
      peer: pending.peer,
      createdAt: pending.createdAt,
    }));
  }

  confirmPairing(id, accepted = true) {
    const pending = this.pendingPairs.get(id);
    if (!pending) return false;
    this.pendingPairs.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(Boolean(accepted));
    this.emit("pair-confirmed", { id, accepted: Boolean(accepted), peer: pending.peer });
    return true;
  }

  #startSession({ role, peer, record, sas, channel }) {
    const nodeId = peer.nodeId;
    const previous = this.sessions.get(nodeId);
    if (previous) {
      try {
        previous.channel.close();
      } catch {
        /* ignore */
      }
    }
    const session = {
      role,
      nodeId,
      peer: { ...peer, record },
      sas,
      channel,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      pending: new Map(),
      closed: false,
      heartbeat: null,
    };
    this.sessions.set(nodeId, session);
    this.emit("session", session);
    this.log(`[federation] ${role} session with ${nodeId} (${peer.name})`);
    this.#startHeartbeat(session);
    this.#sendProfile(session).catch((error) => this.#closeSession(session, error));
    this.#sendHeads(session).catch((error) => this.#closeSession(session, error));
    this.#readLoop(session).catch((error) => this.#closeSession(session, error));
    return session;
  }

  async #readLoop(session) {
    while (!session.closed) {
      const frame = await session.channel.next({ timeoutMs: 0 });
      session.lastSeenAt = Date.now();
      await this.#handleFrame(session, frame);
    }
  }

  #startHeartbeat(session) {
    if (session.heartbeat) return;
    session.heartbeat = setInterval(() => {
      if (session.closed) return;
      try {
        session.channel.send({ t: "ping", id: `ping_${Date.now().toString(36)}` });
      } catch {
        /* close path will handle it */
      }
    }, 30_000);
    session.heartbeat.unref?.();
  }

  async #closeSession(session, error = null) {
    if (session.closed) return;
    session.closed = true;
    if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error ?? new Error("federation session closed"));
    }
    session.pending.clear();
    if (this.sessions.get(session.nodeId) === session) this.sessions.delete(session.nodeId);
    try {
      session.channel.close();
    } catch {
      /* ignore */
    }
    this.emit("close", { nodeId: session.nodeId, error });
  }

  async #sendProfile(session) {
    session.channel.send({ t: "profile", ...(await this.profile()) });
  }

  /**
   * 主动把本节点 profile / heads 推给所有已建立的会话。
   * 用途：配对后再建鱼/删鱼，对端不用重连就能看到（2026-11-08 两机复验发现的问题）。
   */
  async broadcastProfile() {
    if (!this.sessions?.size) return { ok: true, sent: 0 };
    let sent = 0;
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      try {
        await this.#sendProfile(session);
        await this.#sendHeads(session);
        sent += 1;
      } catch (error) {
        this.#closeSession(session, error);
      }
    }
    return { ok: true, sent };
  }

  async #sendHeads(session) {
    session.channel.send({ t: "heads", heads: await this.heads() });
  }

  async profile() {
    const chars = [];
    for (const character of await this.store.list()) {
      try {
        const identity = await this.identity.publicCharacter(character.id);
        chars.push(identity.cert);
      } catch (error) {
        this.log(`[federation] character identity failed for ${character.id}: ${error?.message ?? error}`);
      }
    }
    return {
      v: 1,
      node: this.identity.publicIdentity(),
      chars,
      ...(this.humanCard ? { human: await this.humanCard() } : {}),
    };
  }

  async heads() {
    const heads = [];
    for (const character of await this.store.list()) {
      const events = await this.eventLog.read(character.id);
      const signed = events.filter(isSignedEvent);
      const last = signed[signed.length - 1];
      heads.push({
        char: (await this.identity.ensureCharacter(character.id)).charId,
        seq: last?.seq ?? 0,
        id: last?.id ?? null,
        updatedAt: last?.at ?? character.updatedAt ?? null,
      });
    }
    return heads;
  }

  async eventsSince(characterId, afterSeq = 0, limit = 200) {
    const events = await this.eventLog.read(characterId);
    return events
      .filter((event) => isSignedEvent(event))
      .filter((event) => event.seq > Number(afterSeq ?? 0))
      .filter((event) => event.visibility === "public" || event.visibility === "group")
      .slice(0, Math.max(1, Math.min(500, Number(limit ?? 200))));
  }

  async pull(nodeId, characterId, afterSeq = 0, limit = 200) {
    const session = this.sessions.get(nodeId);
    if (!session) throw new Error(`federation: not connected to ${nodeId}`);
    const response = await this.#request(session, { t: "want", char: characterId, afterSeq, limit });
    if (response?.t !== "events") throw new Error("federation: expected events");
    return response.events ?? [];
  }

  async chat(nodeId, characterId, text, { group = null } = {}) {
    const session = this.sessions.get(nodeId);
    if (session) {
      if (!session.peer.record?.grants?.chat) throw new Error("federation: peer has not granted chat");
      try {
        return await this.#request(session, {
          t: "chat",
          char: characterId,
          text: String(text ?? "").slice(0, MAX_TEXT),
          ...(group ? { group } : {}),
        });
      } catch (error) {
        this.disconnect(nodeId);
        if (!this.courier) throw error;
      }
    }
    return this.#queueChat(nodeId, characterId, text, group);
  }

  async #queueChat(nodeId, characterId, text, group = null) {
    if (!this.courier) throw new Error(`federation: not connected to ${nodeId}`);
    const peer = await this.peerStore.get(nodeId);
    if (!peer?.nodeCert) throw new Error(`federation: unknown peer ${nodeId}`);
    if (peer.blocked) throw new Error("federation: peer is blocked");
    if (!peer.grants?.chat) throw new Error("federation: peer has not granted chat");
    const envelope = await this.courier.send({
      toCert: peer.nodeCert,
      kind: "chat",
      payload: { char: characterId, text: String(text ?? "").slice(0, MAX_TEXT), ...(group ? { group } : {}) },
    });
    return { t: "queued", id: envelope.id, ok: true };
  }

  /**
   * 人-人消息（owner 通道）。message 由 server 侧的 HumanStore 签好，这里只负责
   * 传输：在线走加密会话帧 `t:"human"`，离线走驿站信封（kind:"human"）。
   * 不经过任何角色的队列，也不写进角色事件日志。
   */
  async humanSend(nodeId, message) {
    if (!message || !message.id) throw new Error("federation: human message required");
    const session = this.sessions.get(nodeId);
    if (session) {
      if (!session.peer.record?.grants?.human) {
        const error = new Error("federation: peer has not granted human chat");
        error.code = "HUMAN_NOT_GRANTED";
        throw error;
      }
      const caps = session.peer.caps ?? [];
      if (!caps.includes("human.v1")) {
        const error = new Error("federation: peer is an older version without human.v1");
        error.code = "PEER_NO_HUMAN";
        throw error;
      }
      try {
        return await this.#request(session, { t: "human", msg: message });
      } catch (error) {
        this.disconnect(nodeId);
        if (!this.courier) throw error;
      }
    }
    return this.#queueHuman(nodeId, message);
  }

  async #queueHuman(nodeId, message) {
    if (!this.courier) {
      const error = new Error(`federation: not connected to ${nodeId}`);
      error.code = "NOT_CONNECTED";
      throw error;
    }
    const peer = await this.peerStore.get(nodeId);
    if (!peer?.nodeCert) throw new Error(`federation: unknown peer ${nodeId}`);
    if (peer.blocked) throw new Error("federation: peer is blocked");
    if (peer.grants?.human === false) throw new Error("federation: peer has not granted human chat");
    const envelope = await this.courier.send({
      toCert: peer.nodeCert,
      kind: "human",
      payload: { message },
    });
    return { t: "queued", id: envelope.id, ok: true };
  }

  async sendCourier({ nodeId, kind = "postcard", payload = {} } = {}) {
    if (!this.courier) return null;
    const peer = await this.peerStore.get(nodeId);
    if (!peer?.nodeCert) throw new Error("peer cert missing");
    return this.courier.send({ toCert: peer.nodeCert, kind, payload });
  }

  async sendGroup(nodeId, group) {
    const session = this.sessions.get(nodeId);
    if (session) {
      try {
        return await this.#request(session, { t: "group", group });
      } catch (error) {
        this.disconnect(nodeId);
        if (!this.courier) throw error;
      }
    }
    if (!this.courier) throw new Error(`federation: not connected to ${nodeId}`);
    const peer = await this.peerStore.get(nodeId);
    if (!peer?.nodeCert) throw new Error(`federation: unknown peer ${nodeId}`);
    const envelope = await this.courier.send({ toCert: peer.nodeCert, kind: "group", payload: { group } });
    return { t: "queued", id: envelope.id, ok: true };
  }

  async pollCourier({ limit = 20 } = {}) {
    if (!this.courier) return [];
    const received = await this.courier.receive({ limit });
    const handled = [];
    for (const item of received) {
      if (item.error) continue;
      try {
        if (item.kind === "group") {
          if (this.onGroup && item.payload?.group) {
            await this.onGroup({ nodeId: item.from, group: item.payload.group });
            await this.courier.ack(item.envelope.id);
            handled.push(item);
          }
          continue;
        }
        if (item.kind === "postcard") {
          const postcard = item.payload?.postcard;
          if (!postcard) continue;
          this.emit("postcard", { nodeId: item.from, postcard, fromCert: item.fromCert });
          await this.courier.ack(item.envelope.id);
          handled.push(item);
          continue;
        }
        if (item.kind === "chat") {
          const localId = await this.#localCharacterId(item.payload?.char);
          if (!localId || !this.onChat) continue;
          await this.onChat({
            nodeId: item.from,
            peer: { nodeId: item.from, name: item.fromCert?.name ?? "" },
            characterId: localId,
            text: String(item.payload?.text ?? "").slice(0, MAX_TEXT),
            group: item.payload?.group ?? null,
          });
          await this.courier.ack(item.envelope.id);
          handled.push(item);
          continue;
        }
        if (item.kind === "human") {
          const message = item.payload?.message;
          if (!message || !this.onHuman) continue;
          const result = await this.onHuman({
            nodeId: item.from,
            peer: { nodeId: item.from, name: item.fromCert?.name ?? "" },
            peerCert: item.fromCert,
            message,
          });
          // 验签/链校验失败就不 ack，把信留在驿站，等对端修好后重投。
          if (result === false) continue;
          await this.courier.ack(item.envelope.id);
          handled.push(item);
          continue;
        }
        if (item.kind === "event") {
          const event = item.payload?.event;
          const charCert = item.payload?.charCert;
          if (!event || !charCert) continue;
          const result = verifyCertifiedEvent(event, charCert, item.fromCert);
          if (!result.ok) {
            this.log(`[federation] courier event rejected from ${item.from}: ${result.code}`);
            continue;
          }
          const state = this.#remoteStateFor(item.from, {
            nodeId: item.from,
            nodeCert: item.fromCert,
            name: item.fromCert?.name ?? "",
            hints: [],
            caps: DEFAULT_CAPS,
          });
          state.chars.set(charCert.char, charCert);
          const bucket = state.events.get(event.char) ?? new Map();
          bucket.set(event.seq, event);
          state.events.set(event.char, bucket);
          this.#schedulePersist(state);
          this.emit("event", { nodeId: item.from, event });
          await this.courier.ack(item.envelope.id);
          handled.push(item);
        }
      } catch (error) {
        this.log(`[federation] courier item ${item.envelope?.id ?? "?"} failed: ${error?.message ?? error}`);
      }
    }
    return handled;
  }

  remoteTank(nodeId) {
    const state = this.remote.get(nodeId);
    if (!state) return null;
    return {
      nodeId,
      peer: state.peer,
      chars: [...state.chars.values()],
      heads: [...state.heads.values()],
      events: Object.fromEntries(
        [...state.events.entries()].map(([char, map]) => [char, [...map.values()].sort((a, b) => a.seq - b.seq)]),
      ),
    };
  }

  status() {
    return {
      listening: this.listenAddress ?? null,
      name: this.name,
      nodeId: this.identity.publicIdentity().nodeId,
      caps: this.caps,
      courier: Boolean(this.courier),
      sessions: [...this.sessions.values()].map((session) => ({
        nodeId: session.nodeId,
        role: session.role,
        name: session.peer.name,
        sas: session.sas,
        connectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
      })),
      remotes: [...this.remote.keys()],
    };
  }

  disconnect(nodeId) {
    const session = this.sessions.get(nodeId);
    if (!session) return false;
    try {
      session.channel.close();
    } catch {
      /* ignore */
    }
    return true;
  }

  async #request(session, frame, { timeoutMs = 15000 } = {}) {
    const id = frame.id ?? requestId();
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error(`federation request timeout: ${frame.t}`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      session.pending.set(id, pending);
      try {
        session.channel.send({ ...frame, id });
      } catch (error) {
        session.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error);
      }
    });
  }

  #resolve(session, frame) {
    if (!frame?.id) return false;
    const pending = session.pending.get(frame.id);
    if (!pending) return false;
    session.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(frame);
    return true;
  }

  async #handleFrame(session, frame) {
    if (!frame || typeof frame.t !== "string") return;
    if (frame.t === "ack" || frame.t === "error") {
      this.#resolve(session, frame);
      return;
    }
    if (frame.t === "profile") {
      const state = this.#remoteState(session);
      state.profile = { node: frame.node, chars: frame.chars ?? [], human: frame.human ?? null };
      if (frame.human) {
        state.human = frame.human;
        this.emit("peer-human", { nodeId: session.nodeId, human: frame.human });
      }
      for (const cert of frame.chars ?? []) {
        if (!verifyCharacterCertificate(cert, session.peer.nodeCert)) {
          this.log(`[federation] rejected character cert from ${session.nodeId}`);
          continue;
        }
        state.chars.set(cert.char, cert);
        this.pull(session.nodeId, cert.char, 0, 200).catch((error) =>
          this.log(`[federation] pull failed for ${cert.char}: ${error?.message ?? error}`),
        );
      }
      this.#schedulePersist(state);
      return;
    }
    if (frame.t === "heads") {
      const state = this.#remoteState(session);
      for (const head of frame.heads ?? []) {
        if (head?.char) state.heads.set(head.char, head);
      }
      this.#schedulePersist(state);
      return;
    }
    if (frame.t === "want") return this.#handleWant(session, frame);
    if (frame.t === "events") {
      const events = await this.#ingestEvents(session, frame.char, frame.events ?? []);
      this.#resolve(session, { ...frame, events });
      return;
    }
    if (frame.t === "event") {
      await this.#ingestEvents(session, frame.event?.char, [frame.event]);
      return;
    }
    if (frame.t === "chat") return this.#handleChat(session, frame);
    if (frame.t === "human") return this.#handleHuman(session, frame);
    if (frame.t === "group") {
      if (!this.onGroup) {
        session.channel.send({ t: "error", id: frame.id, code: "NO_HANDLER", error: "group handler not wired" });
        return;
      }
      try {
        await this.onGroup({ nodeId: session.nodeId, group: frame.group });
        session.channel.send({ t: "ack", id: frame.id, ok: true });
      } catch (error) {
        session.channel.send({ t: "error", id: frame.id, code: "GROUP_FAILED", error: String(error?.message ?? error) });
      }
      return;
    }
    if (frame.t === "ping") {
      session.channel.send({ t: "pong", id: frame.id });
      return;
    }
    if (frame.t === "pong") {
      this.#resolve(session, frame);
      return;
    }
  }

  async #localCharacterId(charId) {
    for (const character of await this.store.list()) {
      try {
        const identity = await this.identity.ensureCharacter(character.id);
        if (identity.charId === charId) return character.id;
      } catch {
        // Skip characters whose key material cannot be loaded.
      }
    }
    return null;
  }

  async #handleWant(session, frame) {
    if (!session.peer.record?.grants?.tankView) {
      session.channel.send({ t: "error", id: frame.id, code: "FORBIDDEN", error: "tank.view not granted" });
      return;
    }
    const localId = await this.#localCharacterId(frame.char);
    const character = localId ? await this.store.load(localId).catch(() => null) : null;
    if (!character) {
      session.channel.send({ t: "error", id: frame.id, code: "NOT_FOUND", error: "unknown character" });
      return;
    }
    const events = await this.eventsSince(character.id, frame.afterSeq, frame.limit);
    session.channel.send({ t: "events", id: frame.id, char: frame.char, events });
  }

  async #handleChat(session, frame) {
    if (!session.peer.record?.grants?.chat) {
      session.channel.send({ t: "error", id: frame.id, code: "FORBIDDEN", error: "chat not granted" });
      return;
    }
    const group = frame.group?.id ? frame.group : null;
    let character = null;
    let characterId = String(frame.char ?? "group");
    if (!group) {
      const localId = await this.#localCharacterId(frame.char);
      character = localId ? await this.store.load(localId).catch(() => null) : null;
      if (!character) {
        session.channel.send({ t: "error", id: frame.id, code: "NOT_FOUND", error: "unknown character" });
        return;
      }
      characterId = character.id;
    }
    if (!this.onChat) {
      session.channel.send({ t: "error", id: frame.id, code: "NO_HANDLER", error: "chat handler not wired" });
      return;
    }
    try {
      await this.onChat({
        nodeId: session.nodeId,
        peer: session.peer,
        characterId,
        text: String(frame.text ?? "").slice(0, MAX_TEXT),
        group,
      });
      session.channel.send({ t: "ack", id: frame.id, ok: true });
    } catch (error) {
      session.channel.send({ t: "error", id: frame.id, code: "CHAT_FAILED", error: String(error?.message ?? error) });
    }
  }

  async #handleHuman(session, frame) {
    if (!session.peer.record?.grants?.human) {
      session.channel.send({ t: "error", id: frame.id, code: "FORBIDDEN", error: "human chat not granted" });
      return;
    }
    const message = frame.msg;
    if (!message || message.from !== session.nodeId) {
      session.channel.send({ t: "error", id: frame.id, code: "BAD_FROM", error: "human message origin mismatch" });
      return;
    }
    if (!this.onHuman) {
      session.channel.send({ t: "error", id: frame.id, code: "NO_HANDLER", error: "human handler not wired" });
      return;
    }
    try {
      const result = await this.onHuman({
        nodeId: session.nodeId,
        peer: session.peer,
        peerCert: session.peer.nodeCert,
        message,
      });
      if (result === false) {
        session.channel.send({ t: "error", id: frame.id, code: "REJECTED", error: "human message rejected" });
        return;
      }
      this.emit("human", { nodeId: session.nodeId, message });
      session.channel.send({ t: "ack", id: frame.id, ok: true });
    } catch (error) {
      session.channel.send({ t: "error", id: frame.id, code: "HUMAN_FAILED", error: String(error?.message ?? error) });
    }
  }

  async #ingestEvents(session, charId, events) {
    if (!charId || !Array.isArray(events)) return [];
    const state = this.#remoteState(session);
    const cert = state.chars.get(charId);
    if (!cert) {
      this.log(`[federation] no cert for ${charId}; dropping ${events.length} events`);
      return [];
    }
    const accepted = [];
    const bucket = state.events.get(charId) ?? new Map();
    for (const event of events) {
      const result = verifyCertifiedEvent(event, cert, session.peer.nodeCert);
      if (!result.ok) {
        this.log(`[federation] rejected event ${event?.id ?? "?"} from ${session.nodeId}: ${result.code}`);
        continue;
      }
      bucket.set(event.seq, event);
      accepted.push(event);
      this.emit("event", { nodeId: session.nodeId, event });
    }
    state.events.set(charId, bucket);
    this.#schedulePersist(state);
    return accepted;
  }

  #remoteState(session) {
    return this.#remoteStateFor(session.nodeId, session.peer);
  }

  #remoteStateFor(nodeId, peer) {
    let state = this.remote.get(nodeId);
    if (!state) {
      state = { peer, profile: null, chars: new Map(), heads: new Map(), events: new Map() };
      this.remote.set(nodeId, state);
    }
    return state;
  }

  #broadcast(event) {
    if (!event || event.type === "log.genesis" || event.visibility === "internal") return;
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      const grants = session.peer.record?.grants ?? {};
      const isTank = event.visibility === "public" || event.visibility === "group";
      const isPeerThread = event.source?.thread === `peer:${session.nodeId}`;
      if ((isTank && grants.tankView) || (isPeerThread && grants.chat)) {
        try {
          session.channel.send({ t: "event", event });
        } catch {
          /* the read loop will close it */
        }
      }
    }

    const thread = String(event.source?.thread ?? "");
    if (!thread.startsWith("peer:")) return;
    const peerNodeId = thread.slice("peer:".length);
    if (!peerNodeId || this.sessions.has(peerNodeId)) return;
    this.#queueOfflineEvent(peerNodeId, event).catch((error) =>
      this.log(`[federation] offline event queue failed: ${error?.message ?? error}`),
    );
  }

  async #queueOfflineEvent(peerNodeId, event) {
    if (!this.courier) return;
    if (event.origin !== this.identity.publicIdentity().nodeId) return;
    if (!["message.sent", "message.draft"].includes(event.type)) return;
    const peer = await this.peerStore.get(peerNodeId);
    if (!peer?.nodeCert || peer.blocked || !peer.grants?.chat) return;
    const charCert = await this.identity.publicCharacter(event.characterId);
    await this.courier.send({
      toCert: peer.nodeCert,
      kind: "event",
      payload: { event, charCert: charCert.cert },
    });
  }
}
