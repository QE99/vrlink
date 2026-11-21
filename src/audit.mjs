import fs from "node:fs/promises";
import path from "node:path";

export class AuditLog {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  file(characterId) {
    return path.join(this.baseDir, characterId, "audit", "audit.jsonl");
  }

  async append(characterId, entry) {
    const row = {
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      characterId,
      ...entry,
    };
    const file = this.file(characterId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  async list(characterId, { limit = 100 } = {}) {
    try {
      const text = await fs.readFile(this.file(characterId), "utf8");
      const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return limit > 0 ? rows.slice(-limit) : rows;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
}
