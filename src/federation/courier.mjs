import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { publicKeyFromRawEd25519, verifyNodeCertificate } from "./identity.mjs";
import { canonicalJson, sha256Hex } from "./events.mjs";

const VERSION = 1;
const HKDF_INFO = Buffer.from("vrlink/courier/v1", "utf8");
const MAX_ENVELOPE = 1024 * 1024;
const DEFAULT_TTL_MS = 14 * 86400_000;

function rawPublicBytes(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

function x25519PublicFromRaw(raw) {
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: String(raw ?? "") },
    format: "jwk",
  });
}

function verifyEnvelopeSignature(envelope) {
  if (!envelope?.fromCert || !verifyNodeCertificate(envelope.fromCert)) return false;
  if (envelope.from !== envelope.fromCert.nodeId) return false;
  const { id, sig, ...body } = envelope;
  const expectedId = `sha256:${sha256Hex(canonicalJson(body))}`;
  if (id !== expectedId) return false;
  const publicKey = publicKeyFromRawEd25519(envelope.fromCert.signPub);
  return crypto.verify(
    null,
    Buffer.from(canonicalJson(body), "utf8"),
    publicKey,
    Buffer.from(String(sig ?? ""), "base64url"),
  );
}

export function createEnvelope({ identity, toCert, kind = "chat", payload = {}, expiresAt } = {}) {
  if (!identity) throw new Error("createEnvelope: identity required");
  if (!toCert?.nodeId || !toCert?.encPub) throw new Error("createEnvelope: toCert required");
  const from = identity.publicIdentity().nodeId;
  if (toCert.nodeId === from) throw new Error("createEnvelope: cannot send to self");
  const createdAt = Date.now();
  const expiry = Number(expiresAt ?? createdAt + DEFAULT_TTL_MS);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519PublicFromRaw(toCert.encPub),
  });
  const salt = crypto.randomBytes(16);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, HKDF_INFO, 32));
  const nonce = crypto.randomBytes(12);
  const plaintext = Buffer.from(
    canonicalJson({
      v: VERSION,
      from,
      to: toCert.nodeId,
      kind,
      payload,
      createdAt,
    }),
    "utf8",
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const unsigned = {
    v: VERSION,
    from,
    to: toCert.nodeId,
    fromCert: identity.getNodeCert(),
    createdAt,
    expiresAt: expiry,
    eph: rawPublicBytes(ephemeral.publicKey).toString("base64url"),
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    kind,
  };
  const id = `sha256:${sha256Hex(canonicalJson(unsigned))}`;
  const sig = identity.signBytes(canonicalJson(unsigned));
  return { ...unsigned, id, sig };
}

export function openEnvelope({ envelope, identity } = {}) {
  if (!identity) throw new Error("openEnvelope: identity required");
  if (!envelope || envelope.v !== VERSION) throw new Error("openEnvelope: bad version");
  if (envelope.to !== identity.publicIdentity().nodeId) throw new Error("openEnvelope: not addressed to this node");
  if (Number(envelope.expiresAt) <= Date.now()) throw new Error("openEnvelope: expired");
  if (!verifyEnvelopeSignature(envelope)) throw new Error("openEnvelope: bad sender signature");
  const shared = crypto.diffieHellman({
    privateKey: identity.getNodeEncPrivateKey(),
    publicKey: x25519PublicFromRaw(envelope.eph),
  });
  const key = Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.from(String(envelope.salt), "base64url"), HKDF_INFO, 32),
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(envelope.nonce), "base64url"),
  );
  decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64url"));
  let payload;
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.ciphertext), "base64url")),
      decipher.final(),
    ]);
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw new Error(`openEnvelope: decrypt failed: ${error?.message ?? error}`);
  }
  if (payload.from !== envelope.from || payload.to !== envelope.to) {
    throw new Error("openEnvelope: payload routing mismatch");
  }
  return {
    kind: payload.kind,
    payload: payload.payload,
    from: envelope.from,
    fromCert: envelope.fromCert,
    createdAt: envelope.createdAt,
    id: envelope.id,
  };
}

function tokenFor(tokens, nodeId) {
  return tokens instanceof Map ? tokens.get(nodeId) : tokens?.[nodeId];
}

function nodeForToken(tokens, token) {
  const entries = tokens instanceof Map ? [...tokens.entries()] : Object.entries(tokens ?? {});
  return entries.find(([, value]) => value === token)?.[0] ?? null;
}

function safeFilename(id) {
  return `${sha256Hex(String(id))}.json`;
}

/**
 * Self-hosted store-and-forward courier.
 *
 * It only sees envelope routing metadata; payloads are end-to-end encrypted.
 * Auth is a per-node bearer token (self-hosted deployment; no account system).
 */
export class CourierServer {
  constructor({ dataDir, tokens = {}, ttlMs = DEFAULT_TTL_MS, maxPerRecipient = 1000 } = {}) {
    if (!dataDir) throw new Error("CourierServer: dataDir required");
    this.dataDir = dataDir;
    this.tokens = tokens;
    this.ttlMs = ttlMs;
    this.maxPerRecipient = maxPerRecipient;
    this.server = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    return this;
  }

  async listen(port = 0, host = "127.0.0.1") {
    await this.init();
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#json(res, 500, { ok: false, error: String(error?.message ?? error) });
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
    this.listenAddress = { host, port: typeof address === "object" && address ? address.port : port };
    return this.listenAddress;
  }

  async close() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = String(req.headers["x-courier-token"] ?? "");
    const sender = nodeForToken(this.tokens, token);
    if (url.pathname === "/v1/health") return this.#json(res, 200, { ok: true, app: "vrlink-courier" });
    if (!sender) return this.#json(res, 401, { ok: false, error: "unauthorized" });

    if (url.pathname === "/v1/envelopes" && req.method === "POST") {
      const envelope = await this.#readJson(req);
      if (!envelope || envelope.v !== 1 || envelope.from !== sender || typeof envelope.to !== "string") {
        return this.#json(res, 400, { ok: false, error: "bad envelope" });
      }
      if (!verifyEnvelopeSignature(envelope)) return this.#json(res, 400, { ok: false, error: "bad signature" });
      const size = Buffer.byteLength(JSON.stringify(envelope));
      if (size > MAX_ENVELOPE) return this.#json(res, 413, { ok: false, error: "envelope too large" });
      if (Number(envelope.expiresAt) <= Date.now()) return this.#json(res, 400, { ok: false, error: "expired" });
      if (Number(envelope.expiresAt) > Date.now() + this.ttlMs) {
        return this.#json(res, 400, { ok: false, error: "ttl too long" });
      }
      await this.#cleanup();
      const existing = await this.#countFor(envelope.to);
      if (existing >= this.maxPerRecipient) return this.#json(res, 429, { ok: false, error: "recipient quota full" });
      await this.#write(envelope);
      return this.#json(res, 200, { ok: true, id: envelope.id });
    }

    if (url.pathname === "/v1/envelopes" && req.method === "GET") {
      const to = String(url.searchParams.get("to") ?? "");
      if (!to) return this.#json(res, 400, { ok: false, error: "to required" });
      if (to !== sender) return this.#json(res, 403, { ok: false, error: "wrong recipient" });
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20)));
      await this.#cleanup();
      const envelopes = (await this.#list()).filter((item) => item.to === to).slice(0, limit);
      return this.#json(res, 200, { ok: true, envelopes });
    }

    if (url.pathname === "/v1/ack" && req.method === "POST") {
      const body = await this.#readJson(req);
      const id = String(body?.id ?? "");
      if (!id) return this.#json(res, 400, { ok: false, error: "id required" });
      const envelope = await this.#read(id);
      if (!envelope) return this.#json(res, 200, { ok: true, deleted: false });
      if (envelope.to !== sender) return this.#json(res, 403, { ok: false, error: "wrong recipient" });
      await fs.rm(this.file(id), { force: true });
      return this.#json(res, 200, { ok: true, deleted: true });
    }

    return this.#json(res, 404, { ok: false, error: "not found" });
  }

  file(id) {
    return path.join(this.dataDir, safeFilename(id));
  }

  async #write(envelope) {
    const file = this.file(envelope.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async #read(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #list() {
    let entries = [];
    try {
      entries = await fs.readdir(this.dataDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await fs.readFile(path.join(this.dataDir, name), "utf8")));
      } catch {
        // skip a corrupt envelope
      }
    }
    return out.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  }

  async #countFor(nodeId) {
    return (await this.#list()).filter((item) => item.to === nodeId).length;
  }

  async #cleanup() {
    const now = Date.now();
    for (const envelope of await this.#list()) {
      if (Number(envelope.expiresAt ?? 0) <= now) await fs.rm(this.file(envelope.id), { force: true });
    }
  }

  #readJson(req, limit = MAX_ENVELOPE) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
    });
  }

  #json(res, status, value) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
}

export class CourierClient {
  constructor({ url, identity, token }) {
    if (!url) throw new Error("CourierClient: url required");
    if (!identity) throw new Error("CourierClient: identity required");
    this.url = String(url).replace(/\/+$/, "");
    this.identity = identity;
    this.token = String(token ?? "");
  }
  async send({ toCert, kind = "chat", payload = {}, expiresAt } = {}) {
    const envelope = createEnvelope({ identity: this.identity, toCert, kind, payload, expiresAt });
    await this.deposit(envelope);
    return envelope;
  }

  async deposit(envelope) {
    const response = await fetch(`${this.url}/v1/envelopes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-courier-token": this.token },
      body: JSON.stringify(envelope),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`courier deposit failed: ${response.status} ${body?.error ?? ""}`);
    return body;
  }

  async fetch({ limit = 20 } = {}) {
    const nodeId = this.identity.publicIdentity().nodeId;
    const response = await fetch(
      `${this.url}/v1/envelopes?to=${encodeURIComponent(nodeId)}&limit=${Number(limit)}`,
      { headers: { "x-courier-token": this.token } },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`courier fetch failed: ${response.status} ${body?.error ?? ""}`);
    return body.envelopes ?? [];
  }

  async receive({ limit = 20 } = {}) {
    const envelopes = await this.fetch({ limit });
    const out = [];
    for (const envelope of envelopes) {
      try {
        out.push({ envelope, ...openEnvelope({ envelope, identity: this.identity }) });
      } catch (error) {
        // Leave undecryptable envelopes on the courier; do not ack them.
        out.push({ envelope, error: String(error?.message ?? error) });
      }
    }
    return out;
  }

  async ack(id) {
    const response = await fetch(`${this.url}/v1/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-courier-token": this.token },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`courier ack failed: ${response.status} ${body?.error ?? ""}`);
    return body;
  }
}

/**
 * Fan-out to multiple self-hosted couriers. The same envelope is deposited to
 * every courier (same id), and acknowledgements go to every courier that
 * delivered it. This is intentionally simple: no quorum, no central index.
 */
export class CourierPool {
  constructor({ identity, clients = [] } = {}) {
    if (!identity) throw new Error("CourierPool: identity required");
    this.identity = identity;
    this.clients = clients.filter(Boolean);
    this.deliveredBy = new Map();
  }

  async send({ toCert, kind = "chat", payload = {}, expiresAt } = {}) {
    if (!this.clients.length) throw new Error("courier pool is empty");
    const envelope = createEnvelope({ identity: this.identity, toCert, kind, payload, expiresAt });
    const errors = [];
    let delivered = 0;
    for (const client of this.clients) {
      try {
        await client.deposit(envelope);
        delivered += 1;
      } catch (error) {
        errors.push(error?.message ?? String(error));
      }
    }
    if (!delivered) throw new Error(`courier pool failed: ${errors.join("; ")}`);
    return envelope;
  }

  async receive({ limit = 20 } = {}) {
    const out = [];
    const seen = new Set();
    for (const client of this.clients) {
      let items = [];
      try {
        items = await client.receive({ limit });
      } catch {
        continue;
      }
      for (const item of items) {
        const id = item?.envelope?.id;
        if (!id) continue;
        if (!this.deliveredBy.has(id)) this.deliveredBy.set(id, new Set());
        this.deliveredBy.get(id).add(client);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...item, _courier: client });
      }
    }
    return out;
  }

  async ack(id) {
    const clients = this.deliveredBy.get(id);
    const targets = clients?.size ? [...clients] : this.clients;
    for (const client of targets) {
      try {
        await client.ack(id);
      } catch {
        /* another courier may still have it */
      }
    }
    this.deliveredBy.delete(id);
  }
}
