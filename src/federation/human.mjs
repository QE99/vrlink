import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex } from "./events.mjs";
import { publicKeyFromRawEd25519, verifyNodeCertificate } from "./identity.mjs";

export const HUMAN_CAPS = "human.v1";
export const HUMAN_SCHEMA = "vrlink-human/1";

const MAX_TEXT = 4000;
const MAX_AVATAR = 2;
// 头像图片：压缩后的 data URI（128×128 JPEG 约 4–10KB），上限 ~90KB，防止有人塞大图
const MAX_AVATAR_DATA = 120000;

function cleanAvatarData(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > MAX_AVATAR_DATA) return "";
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : "";
}

function keyFor(nodeId) {
  return crypto.createHash("sha256").update(String(nodeId)).digest("hex").slice(0, 24);
}

function cleanName(value, fallback = "") {
  const text = String(value ?? "").trim().slice(0, 24);
  return text || fallback;
}

function cleanAvatarText(value) {
  return [...String(value ?? "").trim()].slice(0, MAX_AVATAR).join("");
}

function bodyOf(message) {
  return {
    v: 1,
    from: String(message?.from ?? ""),
    to: String(message?.to ?? ""),
    seq: Number(message?.seq ?? 0),
    at: Number(message?.at ?? 0),
    text: String(message?.text ?? ""),
    prev: message?.prev ?? null,
  };
}

function verifyMessage(message, nodeCert) {
  if (!message || message.v !== 1) return { ok: false, code: "BAD_VERSION" };
  if (!nodeCert || !verifyNodeCertificate(nodeCert)) return { ok: false, code: "BAD_CERT" };
  const body = bodyOf(message);
  if (body.from !== nodeCert.nodeId) return { ok: false, code: "BAD_FROM" };
  if (!body.to || !body.text) return { ok: false, code: "EMPTY" };
  if (body.text.length > MAX_TEXT) return { ok: false, code: "TOO_LONG" };
  if (body.seq < 1) return { ok: false, code: "BAD_SEQ" };
  const id = sha256Hex(canonicalJson(body));
  if (message.id !== id) return { ok: false, code: "BAD_ID" };
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(canonicalJson({ ...body, id }), "utf8"),
      publicKeyFromRawEd25519(nodeCert.signPub),
      Buffer.from(String(message.sig ?? ""), "base64url"),
    );
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, code: "BAD_SIG" };
}

function verifySelfCard(card, nodeId) {
  if (!card || card.v !== 1 || card.nodeId !== nodeId) return false;
  try {
    // 签名只覆盖名片正文（不含 signPub/sig）；把 signPub 留在 body 里会让校验永远失败，
    // 重启后用户自己起的名字/头像会被重置成默认值。
    const { sig, signPub, ...body } = card;
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(body), "utf8"),
      publicKeyFromRawEd25519(signPub ?? card.signPub),
      Buffer.from(String(sig ?? ""), "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * 人-人通道（owner channel）。
 *
 * 与角色的 Agent 事件日志完全分离：这里只存"人和人说的话"，不进入任何
 * 角色的上下文，也不产生 message.received / thought 等事件。
 *
 * 存储：
 *   data/human/self.json                     主人名片（签名）
 *   data/human/read.json                     每个线程的已读时间
 *   data/human/threads/<hash>/thread.json    对端节点信息 + 昵称
 *   data/human/threads/<hash>/events.jsonl   逐条签名的消息（append-only，哈希链）
 *
 * 为什么用 hash 目录而不是 nodeId 目录：nodeId 形如 `vrl:node:<base58>`，
 * 冒号在 Windows 路径里不合法。目录名用 sha256(nodeId) 前 24 位，
 * nodeId 原值存在 thread.json 里。
 */
export class HumanStore {
  constructor({ dir, identity, name = "", selfName = "" } = {}) {
    if (!dir) throw new Error("HumanStore: dir required");
    if (!identity) throw new Error("HumanStore: identity required");
    this.dir = path.resolve(dir);
    this.threadsDir = path.join(this.dir, "threads");
    this.identity = identity;
    // 显式配置的名字（环境变量/启动参数），留空就用“鱼友 XXXX”这种可区分的默认名。
    // 不要再默认叫「我」：名片是给对方看的，双方都叫「我」会导致头像分不清谁是谁。
    this.configuredName = cleanName(selfName || name, "");
    const fingerprint = String(identity.publicIdentity().fingerprint ?? "").slice(0, 4).toUpperCase();
    // 默认名 = 身份短码（不是「鱼友 XXXX」）。名字是玩家自己的，不是系统贴的标签。
    this.fallbackName = fingerprint || "VRlink";
    this.defaultName = this.configuredName || this.fallbackName;
    this.self = null;
    this.readMap = {};
    this.queues = new Map();
  }

  async init() {
    await fs.mkdir(this.threadsDir, { recursive: true });
    this.self = await this.#loadSelf();
    this.readMap = await this.#loadJson(path.join(this.dir, "read.json"), {});
    return this;
  }

  get nodeId() {
    return this.identity.publicIdentity().nodeId;
  }

  async #loadSelf() {
    const file = path.join(this.dir, "self.json");
    try {
      const card = JSON.parse(await fs.readFile(file, "utf8"));
      if (card?.nodeId === this.nodeId && verifySelfCard(card, this.nodeId)) {
        // 旧版本默认叫「我」或「鱼友 XXXX」；都迁移到身份短码（用户显式起过名就不动）
        const legacyDefault = !card.name || card.name === "我" || /^鱼友\s*/.test(String(card.name ?? ""));
        if (legacyDefault && !this.configuredName) {
          return this.#writeSelf({ name: this.fallbackName, avatarText: card.avatarText ?? "", avatarData: card.avatarData ?? "" });
        }
        return card;
      }
    } catch {
      /* 没有名片或名片损坏：下面重建 */
    }
    return this.#writeSelf({ name: this.defaultName, avatarText: "" });
  }

  async #writeSelf({ name, avatarText, avatarData }) {
    const body = {
      v: 1,
      nodeId: this.nodeId,
      name: cleanName(name, this.defaultName),
      avatarText: cleanAvatarText(avatarText),
      avatarData: cleanAvatarData(avatarData),
      updatedAt: Date.now(),
    };
    const card = {
      ...body,
      signPub: Buffer.from(
        this.identity.publicIdentity().cert.signPub,
        "base64url",
      ).toString("base64url"),
      sig: this.identity.signDetached(body),
    };
    await fs.mkdir(this.dir, { recursive: true });
    await this.#writeAtomic(path.join(this.dir, "self.json"), card);
    this.self = card;
    return card;
  }

  /** 主人名片（可公开给好友；不含私钥、不含角色信息）。 */
  async card() {
    const self = this.self ?? (await this.getSelf());
    return {
      v: 1,
      nodeId: self.nodeId,
      name: self.name,
      avatarText: self.avatarText,
      avatarData: self.avatarData ?? "",
      updatedAt: self.updatedAt,
    };
  }

  async getSelf() {
    this.self = this.self ?? (await this.#loadSelf());
    return this.self;
  }

  async setSelf(patch = {}) {
    const current = await this.getSelf();
    return this.#writeSelf({
      name: patch.name !== undefined ? patch.name : current.name,
      avatarText: patch.avatarText !== undefined ? patch.avatarText : current.avatarText,
      avatarData: patch.avatarData !== undefined ? patch.avatarData : current.avatarData,
    });
  }

  #threadDir(peerNodeId) {
    return path.join(this.threadsDir, keyFor(peerNodeId));
  }

  async #loadJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async #writeAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Windows 上目标文件正被读取时 rename 会 EPERM/EBUSY；重试几次，别把名片更新静默丢掉。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(error?.code) || attempt === 7) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  #serial(peerNodeId, task) {
    const key = keyFor(peerNodeId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  async threadInfo(peerNodeId) {
    if (!peerNodeId) return null;
    const record = await this.#loadJson(path.join(this.#threadDir(peerNodeId), "thread.json"), null);
    return record?.nodeId === peerNodeId ? record : null;
  }

  /** 记录对端名片（昵称/头像文字）。不会覆盖更旧的名片。 */
  async rememberPeer(peerNodeId, card = {}) {
    if (!peerNodeId || peerNodeId === this.nodeId) return null;
    const dir = this.#threadDir(peerNodeId);
    const existing = await this.threadInfo(peerNodeId);
    const updatedAt = Number(card?.updatedAt ?? 0);
    const keepName = existing?.name && existing?.cardUpdatedAt && updatedAt <= existing.cardUpdatedAt;
    const record = {
      v: 1,
      nodeId: peerNodeId,
      name: keepName ? existing.name : cleanName(card?.name, existing?.name || ""),
      avatarText: keepName ? existing.avatarText ?? "" : cleanAvatarText(card?.avatarText),
      avatarData: keepName ? existing.avatarData ?? "" : cleanAvatarData(card?.avatarData),
      cardUpdatedAt: keepName ? existing.cardUpdatedAt : updatedAt || Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await fs.mkdir(dir, { recursive: true });
    await this.#writeAtomic(path.join(dir, "thread.json"), record);
    return record;
  }

  async #readEntries(peerNodeId) {
    const file = path.join(this.#threadDir(peerNodeId), "events.jsonl");
    let raw = "";
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过损坏行；链校验会从下一行发现断点 */
      }
    }
    return out;
  }

  async #append(peerNodeId, entry) {
    const dir = this.#threadDir(peerNodeId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    const info = (await this.threadInfo(peerNodeId)) ?? {
      v: 1,
      nodeId: peerNodeId,
      name: "",
      avatarText: "",
      cardUpdatedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.#writeAtomic(path.join(dir, "thread.json"), { ...info, updatedAt: Date.now() });
    return entry;
  }

  /**
   * 本地发出的消息：签名后落盘。
   *
   * 序号和 prev 都是"按发送方"算的（只看自己在这次对话里发过的消息）：
   * 两个人各写各的链，接收方按发送方分别校验。以前用整条线程的最后一条来算，
   * 双方各发几条之后序号就撞了，对端会把正常消息当 STALE_SEQ 丢掉（2026-11-11 的消息丢失 bug）。
   */
  async appendLocal(peerNodeId, text) {
    const to = String(peerNodeId ?? "").trim();
    const body = String(text ?? "").trim();
    if (!to) throw new Error("human: peerNodeId required");
    if (!body) throw new Error("human: text required");
    if (body.length > MAX_TEXT) throw new Error("human: text too long");
    return this.#serial(to, async () => {
      const entries = await this.#readEntries(to);
      const mine = entries.filter((entry) => entry.from === this.nodeId);
      const lastMine = mine[mine.length - 1];
      const base = {
        v: 1,
        from: this.nodeId,
        to,
        seq: Number(lastMine?.seq ?? 0) + 1,
        at: Date.now(),
        text: body,
        prev: lastMine?.id ?? null,
      };
      const id = sha256Hex(canonicalJson(base));
      const message = { ...base, id, sig: this.identity.signDetached({ ...base, id }) };
      await this.#append(to, message);
      return message;
    });
  }

  /** 收到对端消息：验节点证书 + 验签 + 按发送方校验序号/链，通过才落盘。 */
  async receive({ nodeId, peerCert, message } = {}) {
    const from = String(nodeId ?? "").trim();
    if (!from || from === this.nodeId) return { ok: false, code: "BAD_FROM" };
    const checked = verifyMessage(message, peerCert);
    if (!checked.ok) return checked;
    if (message.to !== this.nodeId) return { ok: false, code: "BAD_TO" };
    if (message.from !== from) return { ok: false, code: "BAD_FROM" };
    return this.#serial(from, async () => {
      const entries = await this.#readEntries(from);
      if (entries.some((entry) => entry.id === message.id)) return { ok: true, duplicate: true, message };
      const fromPeer = entries.filter((entry) => entry.from === from);
      const lastFromPeer = fromPeer[fromPeer.length - 1];
      const seq = Number(message.seq ?? 0);
      if (lastFromPeer && seq <= Number(lastFromPeer.seq ?? 0)) {
        return { ok: false, code: "STALE_SEQ" };
      }
      // prev 只做"指向的确实是一条见过的消息"这种软校验：双方并行写入、
      // 以及旧版本曾经因为序号 bug 丢过消息，都会让 prev 指向本地没有的条目。
      // 消息本身有发送方签名，不能因为链上有断点就把正常消息丢掉。
      const gap = Boolean(message.prev) && !entries.some((entry) => entry.id === message.prev);
      await this.#append(from, message);
      return gap ? { ok: true, message, gap: true } : { ok: true, message };
    });
  }

  async list(peerNodeId, { limit = 200, since = 0 } = {}) {
    const entries = await this.#readEntries(peerNodeId);
    const after = Number(since) || 0;
    const max = Math.max(1, Math.min(500, Number(limit) || 200));
    return entries.filter((entry) => Number(entry.at) > after).slice(-max);
  }

  /** 校验整条链（返回第一个断点，测试与体检用）。 */
  async verifyThread(peerNodeId, peerCert) {
    const entries = await this.#readEntries(peerNodeId);
    const lastBySender = new Map();
    let legacy = 0;
    for (const entry of entries) {
      if (entry.from === this.nodeId) {
        const body = bodyOf(entry);
        if (sha256Hex(canonicalJson(body)) !== entry.id) return { ok: false, code: "BAD_ID", seq: entry.seq };
      } else {
        const checked = verifyMessage(entry, peerCert);
        if (!checked.ok) return { ...checked, seq: entry.seq };
      }
      // 按发送方各自的链校验；老数据/历史丢消息造成的断点记为 legacy，不判失败
      const expected = lastBySender.get(entry.from) ?? null;
      const prev = entry.prev ?? null;
      if (prev !== expected) legacy += 1;
      lastBySender.set(entry.from, entry.id);
    }
    return { ok: true, count: entries.length, legacy };
  }

  async markRead(peerNodeId, at = Date.now()) {
    const key = keyFor(peerNodeId);
    this.readMap[key] = Math.max(Number(this.readMap[key] ?? 0), Number(at) || Date.now());
    await this.#writeAtomic(path.join(this.dir, "read.json"), this.readMap);
    return this.readMap[key];
  }

  /** 删除好友时连带清掉这个人的聊天记录与已读标记（只删本地，不通知对方）。 */
  async forget(peerNodeId) {
    if (!peerNodeId) return { ok: false, error: "node-id-required" };
    await fs.rm(this.#threadDir(peerNodeId), { recursive: true, force: true });
    const key = keyFor(peerNodeId);
    if (Object.prototype.hasOwnProperty.call(this.readMap, key)) {
      delete this.readMap[key];
      await this.#writeAtomic(path.join(this.dir, "read.json"), this.readMap).catch(() => {});
    }
    return { ok: true, nodeId: peerNodeId };
  }
  /** 线程列表（消息首页用）：按最后一条消息时间倒序。 */
  async threads() {
    const self = this.nodeId;
    let dirs = [];
    try {
      dirs = await fs.readdir(this.threadsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const item of dirs) {
      if (!item.isDirectory()) continue;
      const info = await this.#loadJson(path.join(this.threadsDir, item.name, "thread.json"), null);
      if (!info?.nodeId) continue;
      const entries = await this.#readEntries(info.nodeId);
      const last = entries[entries.length - 1];
      const readAt = Number(this.readMap[item.name] ?? 0);
      const unread = entries.filter((entry) => entry.from !== self && Number(entry.at) > readAt).length;
      out.push({
        nodeId: info.nodeId,
        name: info.name ?? "",
        avatarText: info.avatarText ?? "",
        avatarData: info.avatarData ?? "",
        count: entries.length,
        unread,
        lastText: last?.text ?? "",
        lastAt: last?.at ?? info.updatedAt ?? 0,
        lastFromSelf: last ? last.from === self : false,
        readAt,
      });
    }
    return out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  }
}
