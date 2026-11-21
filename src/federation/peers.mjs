import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function filenameFor(nodeId) {
  return `${crypto.createHash("sha256").update(String(nodeId)).digest("hex").slice(0, 24)}.json`;
}

/**
 * Local peer book. One file per peer, keyed by the peer's self-certifying node id.
 * Grants are local policy; a peer never gets to write them.
 */
export class PeerStore {
  constructor(dir) {
    if (!dir) throw new Error("PeerStore: dir required");
    this.dir = dir;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  file(nodeId) {
    return path.join(this.dir, filenameFor(nodeId));
  }

  async get(nodeId) {
    if (!nodeId) return null;
    try {
      return JSON.parse(await fs.readFile(this.file(nodeId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async list() {
    let entries = [];
    try {
      entries = await fs.readdir(this.dir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
        if (record?.nodeId) out.push(record);
      } catch {
        // Ignore a corrupt peer file; do not take the whole node down.
      }
    }
    return out.sort((a, b) => String(a.name ?? a.nodeId).localeCompare(String(b.name ?? b.nodeId), "zh-CN"));
  }

  async upsert(record) {
    if (!record?.nodeId) throw new Error("PeerStore: nodeId required");
    const existing = await this.get(record.nodeId);
    const next = {
      v: 1,
      ...existing,
      ...record,
      grants: { ...(existing?.grants ?? {}), ...(record.grants ?? {}) },
      blocked: Boolean(record.blocked ?? existing?.blocked ?? false),
      pairedAt: record.pairedAt ?? existing?.pairedAt ?? Date.now(),
      lastSeenAt: Date.now(),
    };
    await this.#write(this.file(record.nodeId), next);
    return next;
  }

  async touch(nodeId, patch = {}) {
    const existing = await this.get(nodeId);
    if (!existing) return null;
    const next = { ...existing, ...patch, lastSeenAt: Date.now() };
    await this.#write(this.file(nodeId), next);
    return next;
  }

  async setGrant(nodeId, grant, value) {
    const existing = await this.get(nodeId);
    if (!existing) return null;
    const next = {
      ...existing,
      grants: { ...(existing.grants ?? {}), [grant]: Boolean(value) },
      updatedAt: new Date().toISOString(),
    };
    await this.#write(this.file(nodeId), next);
    return next;
  }

  async block(nodeId, blocked = true) {
    const existing = await this.get(nodeId);
    if (!existing) return null;
    const next = {
      ...existing,
      blocked: Boolean(blocked),
      revokedAt: blocked ? Date.now() : null,
      updatedAt: new Date().toISOString(),
    };
    await this.#write(this.file(nodeId), next);
    return next;
  }

  async revoke(nodeId) {
    return this.block(nodeId, true);
  }

  async remove(nodeId) {
    await fs.rm(this.file(nodeId), { force: true });
    return { ok: true };
  }

  async #write(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code) || attempt === 4) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
