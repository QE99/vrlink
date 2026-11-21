import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Guest links are capability URLs: random token, hash at rest, short TTL.
 * They only grant read-only access to one character's public projection.
 */
export class GuestTokenStore {
  constructor({ dir, maxTtlMs = 30 * 86400_000 } = {}) {
    if (!dir) throw new Error("GuestTokenStore: dir required");
    this.dir = dir;
    this.file = path.join(dir, "tokens.json");
    this.maxTtlMs = maxTtlMs;
    this.tokens = new Map();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      for (const token of saved?.tokens ?? []) {
        if (token?.id) this.tokens.set(token.id, token);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  async #persist() {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = { v: 1, tokens: [...this.tokens.values()], savedAt: Date.now() };
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, token] of this.tokens) {
      if (Number(token.expiresAt) <= now) this.tokens.delete(id);
    }
  }

  async create({ characterId, label = "", ttlHours = 24 } = {}) {
    if (!characterId) throw new Error("guest token: characterId required");
    const ttl = Math.min(this.maxTtlMs, Math.max(60_000, Number(ttlHours) * 3600_000 || 86400_000));
    const token = crypto.randomBytes(32).toString("base64url");
    const record = {
      id: `guest_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      tokenHash: hashToken(token),
      characterId,
      label: String(label ?? "").slice(0, 80),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    this.tokens.set(record.id, record);
    await this.#persist();
    return { token, record };
  }

  async resolve(token) {
    this.#cleanup();
    const tokenHash = hashToken(token);
    for (const record of this.tokens.values()) {
      if (record.tokenHash === tokenHash && Number(record.expiresAt) > Date.now()) return record;
    }
    return null;
  }

  list() {
    this.#cleanup();
    return [...this.tokens.values()].map(({ tokenHash, ...rest }) => rest);
  }

  async revoke(id) {
    const record = this.tokens.get(String(id));
    if (!record) return null;
    this.tokens.delete(String(id));
    await this.#persist();
    return { id: record.id };
  }
}
