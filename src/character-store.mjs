import fs from "node:fs/promises";
import path from "node:path";
import { assert, normalizeId, validateCharacter } from "./contracts.mjs";

const DEMO = {
  id: "lin_wan",
  name: "林晚",
  persona: {
    identity: "26 岁，夜班护士，住在隔壁",
    baseline: "嘴硬心软，累的时候话更短",
    quirks: ["会先叹气", "值夜班时回得慢"],
    examples: [{ user: "在吗", her: "……嗯。刚醒。" }],
  },
  brain: { engine: "mock", model: "mock", temperature: 0.7 },
  bodies: [
    { id: "desktop-main", type: "desktop", account: "local" },
  ],
};

function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 2 ? slug : "";
}

/**
 * One fish = one directory:
 *   characters/<id>/character.json
 *   characters/<id>/events.jsonl
 *   characters/<id>/memory/memory.jsonl
 *   characters/<id>/state.json
 *   characters/<id>/audit/audit.jsonl
 */
export class CharacterStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  dir(id) {
    return path.join(this.baseDir, normalizeId(id));
  }

  async init({ seed = true } = {}) {
    await fs.mkdir(this.baseDir, { recursive: true });
    const list = await this.list();
    if (!list.length && seed) await this.create(DEMO);
  }

  async create(input) {
    const character = validateCharacter({
      ...input,
      id: input.id ?? (slugify(input.name) || `char_${Date.now().toString(36)}`),
    });
    const dir = this.dir(character.id);
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.mkdir(path.join(dir, "audit"), { recursive: true });
    await this.writeJson(path.join(dir, "character.json"), character);
    await this.writeState(character.id, {
      mood: "平静",
      energy: 0.7,
      openness: 0.6,
      unread: 0,
      lastActiveAt: null,
      eventCount: 0,
    });
    return character;
  }

  async load(id) {
    const file = path.join(this.dir(id), "character.json");
    const text = await fs.readFile(file, "utf8");
    return validateCharacter(JSON.parse(text));
  }

  async list() {
    let entries = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        out.push(await this.load(entry.name));
      } catch {
        // 坏目录不阻塞列表
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async save(character) {
    const normalized = validateCharacter({ ...character, updatedAt: new Date().toISOString() });
    await this.writeJson(path.join(this.dir(normalized.id), "character.json"), normalized);
    return normalized;
  }

  async remove(id) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
    return { ok: true };
  }

  async state(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), "state.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async updateState(id, patch) {
    const current = (await this.state(id)) ?? {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.writeState(id, next);
    return next;
  }

  async writeState(id, state) {
    await fs.mkdir(this.dir(id), { recursive: true });
    await this.writeJson(path.join(this.dir(id), "state.json"), state);
  }

  async appendMemory(id, memory) {
    assert(memory && typeof memory.text === "string" && memory.text.trim(), "memory.text required");
    const row = {
      id: memory.id ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: memory.at ?? Date.now(),
      text: memory.text.trim(),
      source: memory.source ?? "unknown",
      visibility: memory.visibility ?? "private",
      confidence: memory.confidence ?? 0.5,
    };
    const file = path.join(this.dir(id), "memory", "memory.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  async listMemory(id, { limit = 0 } = {}) {
    try {
      const text = await fs.readFile(path.join(this.dir(id), "memory", "memory.jsonl"), "utf8");
      const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return limit > 0 ? rows.slice(-limit) : rows;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async exportTo(id, destination) {
    await fs.cp(this.dir(id), destination, { recursive: true });
    return { ok: true, from: this.dir(id), to: destination };
  }

  async importFrom(sourceDir, { id } = {}) {
    const raw = JSON.parse(await fs.readFile(path.join(sourceDir, "character.json"), "utf8"));
    const character = validateCharacter({ ...raw, id: id ?? raw.id });
    const target = this.dir(character.id);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(sourceDir, target, { recursive: true });
    await this.writeJson(path.join(target, "character.json"), character);
    return character;
  }

  async snapshot(id) {
    const state = await this.state(id);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.dir(id), "snapshots", `state-${stamp}.json`);
    await this.writeJson(file, state ?? {});
    return { ok: true, file };
  }

  async writeAsset(id, relativePath, buffer) {
    const base = this.dir(id);
    const target = path.resolve(base, relativePath);
    if (!target.startsWith(base + path.sep)) throw new Error(`unsafe asset path: ${relativePath}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return target;
  }

  async snapshots(id) {
    const dir = path.join(this.dir(id), "snapshots");
    try {
      const files = await fs.readdir(dir);
      return files.filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }
}
