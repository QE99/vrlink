#!/usr/bin/env node
// Migrate a VRlink v1 Hub state (state.json + behaviors/) into a VRlink v2 data directory.
//
// v1 source layout (read-only):
//   <hub>/state.json          { revision, state: { me, settings, characters[], chats, memories, diary, ... } }
//   <hub>/behaviors/*.json    { version, character, packId, current, vars, proactive, idleMinutes, ... }
//   <hub>/plugins/*           v1 plugin folders (NOT migrated; format differs)
//
// v2 target layout (only the characters/cards/migration dirs are touched):
//   <data>/characters/<id>/character.json
//   <data>/characters/<id>/state.json
//   <data>/characters/<id>/events.jsonl
//   <data>/characters/<id>/memory/memory.jsonl
//   <data>/cards/<id>.card.json
//   <data>/migration/{report.json,v1-app-state.json}
//   <data>/.vrlink-migration.json        idempotency marker
//
// Usage:
//   node tools/migrate-from-v1.mjs --dry-run
//   node tools/migrate-from-v1.mjs --from "<旧 hub 目录>" --to "<当前 data 目录>"
//   node tools/migrate-from-v1.mjs --from <hub> --from "<旧 desktop/data>" --to <data>
//
// Safety:
//   * source is never written; token.txt / pair.json are never read;
//   * a non-empty target is refused unless --overwrite (or this is an idempotent re-run of
//     the same source, detected via .vrlink-migration.json);
//   * --overwrite only replaces the character dirs/cards named by this migration.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeId, validateCharacter, validateEvent } from "../src/contracts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_V1 = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "vrlink", "hub");
const DEFAULT_V2 = path.join(ROOT, "data");
const MARKER = ".vrlink-migration.json";

const USAGE = `VRlink v1 → v2 迁移

用法:
  node tools/migrate-from-v1.mjs [--from <hub目录|state.json>]... [--to <v2 data目录>] [--dry-run] [--overwrite] [--json]

参数:
  --from <path>    v1 数据来源：含 state.json 的目录，或 state.json 文件本身；可重复多次（后一个来源补全前一个）。
                   默认: %APPDATA%\\vrlink\\hub
  --to <path>      v2 data 目录（其下写 characters/、cards/、migration/）。默认: <仓库>/data
  --dry-run       只打印迁移计划，不写任何文件。
  --overwrite     目标非空且不是同一来源的重复迁移时，允许覆盖本次要迁移的角色目录与卡片。
  --json          以 JSON 输出计划/报告（便于脚本处理）。
  -h, --help      显示帮助。
`;

function parseArgs(argv) {
  const options = { from: [], to: null, dryRun: false, overwrite: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数缺少值: ${arg}`);
      return value;
    };
    if (arg === "--from") options.from.push(next());
    else if (arg.startsWith("--from=")) options.from.push(arg.slice("--from=".length));
    else if (arg === "--to") options.to = next();
    else if (arg.startsWith("--to=")) options.to = arg.slice("--to=".length);
    else if (arg === "--dry-run" || arg === "--dryRun") options.dryRun = true;
    else if (arg === "--overwrite" || arg === "--force") options.overwrite = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

// ---------- helpers ----------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function slugifyId(value) {
  let id = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!/^[a-z0-9]/.test(id)) id = `char-${id}`.slice(0, 40);
  return id.length >= 2 ? id : "char-imported";
}

function resolveCharacterId(rawId) {
  try {
    return { id: normalizeId(rawId), normalized: true };
  } catch {
    return { id: slugifyId(rawId), normalized: false };
  }
}

function toIsoOrNull(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toMsOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJsonFile(file) {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeLines(file, lines) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// 迁移会把 v1 全局状态（可能含 API key 等）落到 migration/v1-app-state.json；写盘前清洗。
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[-_]?key|apikey|key|password|passwd|secret|token)$/i.test(key)) {
        out[key] = child ? "[redacted]" : child;
        continue;
      }
      out[key] = redactSecrets(child);
    }
    return out;
  }
  return value;
}

// ---------- source loading ----------

async function loadSource(input, index) {
  const absolute = path.resolve(input);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat) throw new Error(`迁移来源不存在: ${absolute}`);
  const dir = stat.isDirectory() ? absolute : path.dirname(absolute);
  const stateFile = stat.isDirectory() ? path.join(absolute, "state.json") : absolute;
  let json;
  try {
    json = await readJsonFile(stateFile);
  } catch (error) {
    throw new Error(`读不了 v1 state（${stateFile}）: ${error?.message ?? error}`);
  }
  if (!isPlainObject(json) || !isPlainObject(json.state) || !Array.isArray(json.state.characters)) {
    throw new Error(`不支持的 v1 state 结构（期望 {revision,state:{characters[]}}）: ${stateFile}`);
  }

  const behaviorsDir = path.join(dir, "behaviors");
  const behaviors = [];
  const warnings = [];
  for (const entry of await listDirSafe(behaviorsDir)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(behaviorsDir, entry.name);
    try {
      behaviors.push({ file, name: entry.name, data: await readJsonFile(file) });
    } catch (error) {
      warnings.push(`行为包解析失败，已跳过: ${entry.name} (${error?.message ?? error})`);
    }
  }

  const pluginsDir = path.join(dir, "plugins");
  const pluginEntries = (await listDirSafe(pluginsDir)).map((entry) => entry.name);

  return {
    index,
    input: absolute,
    dir,
    stateFile,
    revision: json.revision ?? null,
    state: json.state,
    behaviors,
    pluginEntries,
    warnings,
    // 只用于幂等指纹；不含 token.txt / pair.json
    contentHash: hashJson({ state: json.state, behaviors: behaviors.map((item) => item.data) }),
  };
}

// ---------- planning ----------

function buildPlan(sources, { now } = {}) {
  const warnings = [];
  const characters = new Map(); // id -> { id, originalId, name, raw, sources:Set, aliases:Set, behaviors:Set, chatKeys:[], memoryKeys:[] }
  const alias = new Map(); // normalizeKey -> id

  const registerAlias = (value, id) => {
    const key = normalizeKey(value);
    if (key) alias.set(key, id);
  };

  for (const source of sources) {
    for (const raw of source.state.characters) {
      if (!isPlainObject(raw) || !raw.id) {
        warnings.push(`来源 #${source.index + 1} 有一个角色缺少 id，已跳过: ${JSON.stringify(raw)?.slice(0, 80)}`);
        continue;
      }
      const resolved = resolveCharacterId(raw.id);
      if (!resolved.normalized) {
        warnings.push(`角色 id 不适合 v2（${raw.id}），已规范化为 ${resolved.id}`);
      }
      let id = resolved.id;
      // 不同原始 id 撞到同一个规范化 id 时加后缀，避免互相覆盖
      if (characters.has(id) && characters.get(id).originalId !== String(raw.id)) {
        let suffix = 2;
        while (characters.has(`${id}_${suffix}`)) suffix += 1;
        id = `${id}_${suffix}`;
        warnings.push(`角色 id 冲突，已改用 ${id}（原名 ${raw.id}）`);
      }
      if (!characters.has(id)) {
        characters.set(id, {
          id,
          originalId: String(raw.id),
          name: String(raw.name ?? raw.id).slice(0, 24),
          raw: { ...raw },
          sources: new Set([source.index]),
          aliases: new Set(),
          behaviors: [],
          behaviorFiles: new Set(),
          chatKeys: [],
          memoryKeys: [],
        });
      } else {
        const existing = characters.get(id);
        existing.sources.add(source.index);
        // 后一个来源只补缺失字段；核心字段以第一个来源为准
        for (const [key, value] of Object.entries(raw)) {
          if (existing.raw[key] === undefined) existing.raw[key] = value;
        }
      }
      const character = characters.get(id);
      registerAlias(raw.id, id);
      registerAlias(character.name, id);
      registerAlias(raw.name, id);
      character.aliases.add(normalizeKey(raw.id));
    }
  }

  // behaviors: attach to the character they name
  for (const source of sources) {
    for (const behavior of source.behaviors) {
      const data = behavior.data ?? {};
      const candidate = data.character ?? behavior.name.split("--")[0];
      const id = alias.get(normalizeKey(candidate));
      if (!id || !characters.has(id)) {
        warnings.push(`行为包无法匹配角色，未迁移: ${behavior.name}（character=${candidate ?? "?"}）`);
        continue;
      }
      const character = characters.get(id);
      if (character.behaviorFiles.has(behavior.name)) continue;
      character.behaviorFiles.add(behavior.name);
      character.behaviors.push({ file: behavior.name, ...data });
    }
  }

  // chats / memories: v1 keys may be the character id, the character name, or a slug ("linwan")
  const collect = (field) => {
    for (const source of sources) {
      const bucket = source.state[field];
      if (!isPlainObject(bucket)) continue;
      for (const [key, entries] of Object.entries(bucket)) {
        if (!Array.isArray(entries)) continue;
        const id = alias.get(normalizeKey(key));
        if (!id || !characters.has(id)) {
          warnings.push(`v1 ${field}["${key}"] 无法匹配任何角色，未迁移`);
          continue;
        }
        const character = characters.get(id);
        const target = field === "chats" ? character.chatKeys : character.memoryKeys;
        target.push({ key, source, entries });
      }
    }
  };
  collect("chats");
  collect("memories");

  // build per-character derived data
  const plans = [];
  for (const character of characters.values()) {
    const baseMs =
      toMsOrNull(character.raw.updatedAt) ??
      toMsOrNull(now) ??
      Date.now();

    const events = buildEvents(character, baseMs, warnings);
    const memories = buildMemories(character, baseMs, warnings);

    const v1State = isPlainObject(character.raw.state) ? character.raw.state : {};
    const persona = {
      identity: String(character.raw.persona?.identity ?? character.raw.relation ?? "").slice(0, 500),
      baseline: String(character.raw.persona?.baseline ?? "").slice(0, 1000),
      quirks: Array.isArray(character.raw.persona?.quirks) ? character.raw.persona.quirks.slice(0, 50) : [],
      boundaries: Array.isArray(character.raw.persona?.boundaries) ? character.raw.persona.boundaries.slice(0, 50) : [],
    };
    for (const key of ["greeting", "lore", "rules", "speech"]) {
      if (character.raw[key] !== undefined) persona[key] = character.raw[key];
    }
    const brain = {
      engine: "mock",
      model: String(character.raw.model?.id ?? "v1-unknown").slice(0, 120),
      temperature: Number.isFinite(Number(character.raw.temperature)) ? Number(character.raw.temperature) : 0.7,
    };
    const createdAt = toIsoOrNull(character.raw.updatedAt) ?? new Date(now ?? Date.now()).toISOString();
    const updatedAt = new Date(now ?? Date.now()).toISOString();
    const sourcesList = [...character.sources].sort((a, b) => a - b).map((idx) => ({
      path: sources[idx].input,
      revision: sources[idx].revision,
    }));

    const v2Character = validateCharacter({
      id: character.id,
      name: character.name,
      persona,
      brain,
      bodies: [],
      createdAt,
      updatedAt,
      "x-vrlink": {
        migration: {
          kind: "vrlink-v1",
          version: 1,
          at: updatedAt,
          originalId: character.originalId,
          sources: sourcesList,
        },
        v1: {
          character: character.raw,
          behaviors: character.behaviors,
        },
      },
    });

    const lastEvent = events[events.length - 1] ?? null;
    const mood = mapMood(v1State.mood);
    const state = {
      mood,
      energy: clamp01(v1State.energy, 0.7),
      openness: 0.6,
      unread: Number.isFinite(Number(character.raw.unread)) ? Number(character.raw.unread) : 0,
      lastActiveAt: lastEvent?.at ?? null,
      lastEventType: lastEvent?.type ?? null,
      eventCount: events.length,
      trust: Number.isFinite(Number(v1State.trust)) ? Number(v1State.trust) : null,
      usage: { day: new Date(now ?? Date.now()).toISOString().slice(0, 10), turns: 0, tokens: 0, cost: 0 },
      overBudget: false,
      updatedAt,
      "x-v1": { state: v1State },
    };

    const card = {
      id: character.id,
      name: character.name,
      source: {
        kind: "vrlink-v1-migration",
        version: 1,
        at: updatedAt,
        originalId: character.originalId,
        sources: sourcesList,
        note: "从 VRlink v1 Hub state 迁移；behaviors 为 v1 行为包状态快照，v2 不执行 v1 行为脚本。",
      },
      persona,
      brain,
      behaviors: character.behaviors,
    };

    plans.push({
      character: v2Character,
      state,
      card,
      events,
      memories,
      behaviorCount: character.behaviors.length,
      chatKeys: character.chatKeys.map((item) => `${item.source.index + 1}:${item.key}`),
      memoryKeys: character.memoryKeys.map((item) => `${item.source.index + 1}:${item.key}`),
      sources: sourcesList,
    });
  }

  plans.sort((a, b) => a.character.id.localeCompare(b.character.id, "zh-CN"));
  return { characters: plans, warnings };
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function mapMood(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return typeof value === "string" && value.trim() ? value.trim() : "平静";
  }
  if (number > 0.2) return "愉快";
  if (number < -0.2) return "低落";
  return "平静";
}

function buildEvents(character, baseMs, warnings) {
  const events = [];
  const importedBlocks = [];
  let seq = 0;
  for (const block of character.chatKeys) {
    const messages = block.entries.filter((entry) => isPlainObject(entry) && (entry.side === "in" || entry.side === "out"));
    const signature = JSON.stringify(messages.map((entry) => [entry.side, entry.text]));
    if (messages.length && importedBlocks.includes(signature)) {
      warnings.push(`跳过重复聊天块 chats["${block.key}"]（来源 #${block.source.index + 1}，与已迁移内容相同）`);
      continue;
    }
    if (messages.length) importedBlocks.push(signature);
    let pendingTime = null;
    for (const entry of block.entries) {
      if (!isPlainObject(entry)) continue;
      if (entry.side === "time") {
        pendingTime = String(entry.text ?? "");
        continue;
      }
      if (entry.side !== "in" && entry.side !== "out") continue;
      const text = String(entry.text ?? "").trim();
      if (!text) continue;
      const realAt = toMsOrNull(entry.at);
      const at = realAt ?? baseMs + seq * 1000;
      const content = { text };
      if (pendingTime) content.v1Time = pendingTime;
      if (entry.proactive) content.proactive = true;
      pendingTime = null;
      seq += 1;
      events.push(
        validateEvent({
          id: `evt_v1_${character.id}_${String(seq).padStart(4, "0")}`,
          characterId: character.id,
          at,
          type: entry.side === "in" ? "message.sent" : "message.received",
          source: {
            body: "desktop",
            thread: "main",
            actor: entry.side === "out" ? { id: "owner", name: "我" } : null,
          },
          visibility: "private",
          content,
        }),
      );
    }
  }
  return events;
}

function buildMemories(character, baseMs, warnings) {
  const rows = [];
  const importedBlocks = [];
  const seenText = new Set();
  let seq = 0;
  for (const block of character.memoryKeys) {
    const entries = block.entries.filter((entry) => isPlainObject(entry) && String(entry.text ?? "").trim());
    const signature = JSON.stringify(entries.map((entry) => [entry.id ?? "", entry.text]));
    if (entries.length && importedBlocks.includes(signature)) {
      warnings.push(`跳过重复记忆块 memories["${block.key}"]（来源 #${block.source.index + 1}，与已迁移内容相同）`);
      continue;
    }
    if (entries.length) importedBlocks.push(signature);
    for (const entry of entries) {
      const text = String(entry.text).trim();
      if (seenText.has(text)) continue;
      seenText.add(text);
      seq += 1;
      const importance = Number(entry.importance);
      rows.push({
        id: `mem_v1_${character.id}_${String(seq).padStart(4, "0")}`,
        at: baseMs + seq * 1000,
        text,
        source: "v1:migrate",
        visibility: "private",
        confidence: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance / 5)) : 0.5,
        importance: Number.isFinite(importance) ? importance : null,
        v1Id: entry.id ?? null,
        v1At: entry.at ?? null,
      });
    }
  }
  // lore 是角色"本来就记得"的设定，也进 memory（可被检索），原文另存 character.json 的 x-vrlink.v1.character.lore
  const lore = Array.isArray(character.raw.lore) ? character.raw.lore : [];
  for (const item of lore) {
    const text = typeof item === "string" ? item : String(item?.fact ?? "").trim();
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    seq += 1;
    rows.push({
      id: `mem_v1_${character.id}_lore_${String(seq).padStart(4, "0")}`,
      at: baseMs + seq * 1000,
      text,
      source: "v1:lore",
      visibility: "private",
      confidence: 0.9,
      importance: 5,
      v1At: isPlainObject(item) ? item.when ?? null : null,
    });
  }
  return rows;
}

// ---------- target handling ----------

function summarizePlan(plan, sources) {
  return {
    characters: plan.characters.map((item) => ({
      id: item.character.id,
      name: item.character.name,
      events: item.events.length,
      memories: item.memories.length,
      behaviors: item.behaviorCount,
      chatKeys: item.chatKeys,
      memoryKeys: item.memoryKeys,
      sources: item.sources,
    })),
    totals: {
      characters: plan.characters.length,
      events: plan.characters.reduce((sum, item) => sum + item.events.length, 0),
      memories: plan.characters.reduce((sum, item) => sum + item.memories.length, 0),
      behaviors: plan.characters.reduce((sum, item) => sum + item.behaviorCount, 0),
    },
    sources: sources.map((source) => ({
      path: source.input,
      revision: source.revision,
      characters: source.state.characters.length,
      behaviors: source.behaviors.length,
      pluginEntries: source.pluginEntries.length,
    })),
    warnings: plan.warnings,
  };
}

function lostItems(sources) {
  const anyPlugins = sources.some((source) => source.pluginEntries.length > 0);
  return [
    "v1 全局设置 settings（主题/引擎/API 配置/计算模式等）：不写入 v2 配置，原样（密钥已清洗）保存在 migration/v1-app-state.json",
    "v1 模型清单 models：不迁移（v2 用 brain engine 配置，模型名保存在 character.json 的 x-vrlink.v1.model）",
    "v1 日记 diary：v2 没有对应结构，原样保存在 migration/v1-app-state.json",
    "v1 summaries / herState / judges / lastRoute / favorites：v2 没有对应结构，原样保存在 migration/v1-app-state.json",
    "v1 plugins/：插件格式与 v2 不同，未迁移（不复制、不执行）",
    "token.txt / pair.json：配对凭据与 v2 无关，未读取、未迁移",
    "v1 语音/表情/行为脚本（voice/speech/behaviors）：只作为数据保存在 character.json 与 cards/*.card.json，v2 不执行",
    anyPlugins ? "来源 plugins/ 目录非空：请在 v2 的插件中心重新安装等价插件" : "来源 plugins/ 目录为空：无插件数据丢失",
  ];
}

async function resolveTargetMode(toDir, fingerprint, overwrite) {
  const entries = await listDirSafe(toDir);
  if (!entries.length) return { mode: "create", previous: null };
  const markerFile = path.join(toDir, MARKER);
  let previous = null;
  if (await pathExists(markerFile)) {
    try {
      previous = await readJsonFile(markerFile);
    } catch {
      previous = null;
    }
  }
  if (previous?.fingerprint && previous.fingerprint === fingerprint) {
    return { mode: "rerun", previous };
  }
  if (overwrite) return { mode: "overwrite", previous };
  const names = entries.map((entry) => entry.name);
  const error = new Error(
    `目标目录非空: ${toDir}（${names.length} 项: ${names.slice(0, 6).join(", ")}${names.length > 6 ? " …" : ""}）。` +
      "为避免覆盖真实数据已停止；如确认要覆盖本次迁移的角色，请加 --overwrite。",
  );
  error.code = "TARGET_NOT_EMPTY";
  throw error;
}

function previousAt(target) {
  const at = target?.previous?.at;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null;
}

// ---------- main flow ----------

export async function migrateFromV1(options = {}) {
  const from = options.from?.length ? options.from : [DEFAULT_V1];
  const to = path.resolve(options.to ?? DEFAULT_V2);
  const now = options.now ?? new Date().toISOString();
  const dryRun = Boolean(options.dryRun);
  const overwrite = Boolean(options.overwrite);

  const sources = [];
  for (let i = 0; i < from.length; i += 1) sources.push(await loadSource(from[i], i));

  const fingerprint = hashJson(sources.map((source) => ({ contentHash: source.contentHash })));
  const target = await resolveTargetMode(to, fingerprint, overwrite);
  // 幂等重跑时沿用首次迁移的时间戳，保证角色数据文件逐字节不变。
  const dataNow = target.mode === "rerun" && previousAt(target) ? previousAt(target) : now;
  const plan = buildPlan(sources, { now: dataNow });

  const summary = summarizePlan(plan, sources);
  const baseReport = {
    ok: true,
    tool: "tools/migrate-from-v1.mjs",
    version: 1,
    at: now,
    dryRun,
    mode: target.mode,
    fingerprint,
    from: summary.sources,
    to,
    characters: summary.characters,
    totals: summary.totals,
    warnings: [
      ...sources.flatMap((source) => source.warnings),
      ...sources
        .filter((source) => source.pluginEntries.length > 0)
        .map((source) => `来源 plugins/ 有 ${source.pluginEntries.length} 个条目，v1 插件格式与 v2 不同，未迁移（请在 v2 插件中心重装等价插件）`),
      ...summary.warnings,
    ],
    lost: lostItems(sources),
  };

  if (dryRun) {
    return {
      ...baseReport,
      dryRun: true,
      wrote: [],
      next:
        target.mode === "rerun"
          ? "目标已有同一来源的迁移标记，可幂等重跑。"
          : target.mode === "create"
            ? "目标为空，可直接运行（去掉 --dry-run）。"
            : "目标非空且不是同一来源；正式运行需要 --overwrite。",
    };
  }

  const wrote = [];
  // 覆盖/重跑：只清理本次要迁移的角色目录与卡片，绝不整盘删除
  for (const item of plan.characters) {
    const dir = path.join(to, "characters", item.character.id);
    if (await pathExists(dir)) await fs.rm(dir, { recursive: true, force: true });
  }
  for (const item of plan.characters) {
    const dir = path.join(to, "characters", item.character.id);
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await writeJson(path.join(dir, "character.json"), item.character);
    await writeJson(path.join(dir, "state.json"), item.state);
    await writeLines(path.join(dir, "events.jsonl"), item.events);
    await writeLines(path.join(dir, "memory", "memory.jsonl"), item.memories);
    wrote.push(
      `characters/${item.character.id}/character.json`,
      `characters/${item.character.id}/state.json`,
      `characters/${item.character.id}/events.jsonl`,
      `characters/${item.character.id}/memory/memory.jsonl`,
    );
    const cardFile = path.join(to, "cards", `${item.character.id}.card.json`);
    await writeJson(cardFile, item.card);
    wrote.push(`cards/${item.character.id}.card.json`);
  }

  // 未映射的 v1 全局数据：只落 migration/，不参与 v2 运行
  const appState = {
    note: "v1 全局数据快照。仅作留档，v2 不读取；密钥类字段已清洗。",
    sources: sources.map((source) => ({
      path: source.input,
      revision: source.revision,
      currentId: source.state.currentId ?? null,
      firstRunAccepted: source.state.firstRunAccepted ?? null,
      me: redactSecrets(source.state.me ?? null),
      settings: redactSecrets(source.state.settings ?? null),
      diary: source.state.diary ?? [],
      models: source.state.models ?? [],
      summaries: source.state.summaries ?? {},
      herState: source.state.herState ?? {},
      judges: source.state.judges ?? {},
      lastRoute: source.state.lastRoute ?? {},
      favorites: source.state.favorites ?? [],
      installed: source.state.installed ?? null,
      plugins: { files: source.pluginEntries, migrated: false },
    })),
  };
  await writeJson(path.join(to, "migration", "v1-app-state.json"), appState);
  await writeJson(path.join(to, "migration", "report.json"), { ...baseReport, wrote });
  wrote.push("migration/v1-app-state.json", "migration/report.json");

  const marker = {
    version: 1,
    tool: "tools/migrate-from-v1.mjs",
    at: dataNow,
    fingerprint,
    from: sources.map((source) => ({ path: source.input, revision: source.revision, contentHash: source.contentHash })),
    characters: plan.characters.map((item) => ({
      id: item.character.id,
      events: item.events.length,
      memories: item.memories.length,
    })),
  };
  await writeJson(path.join(to, MARKER), marker);
  wrote.push(MARKER);

  return {
    ...baseReport,
    dryRun: false,
    wrote,
    next: `VRLINK_V2_DATA="${to}" node src/server.mjs  # 或 npm start，然后用 GET /api/characters 检查`,
  };
}

function formatHuman(result) {
  const lines = [];
  lines.push(`VRlink v1 → v2 迁移${result.dryRun ? "（dry-run，未写文件）" : "完成"}`);
  lines.push(`目标: ${result.to}`);
  lines.push(`模式: ${result.mode}`);
  for (const source of result.from) {
    lines.push(`来源: ${source.path}（revision=${source.revision}，角色 ${source.characters}，行为包 ${source.behaviors}）`);
  }
  lines.push("");
  for (const character of result.characters) {
    lines.push(
      `  - ${character.id}「${character.name}」: 事件 ${character.events}，记忆 ${character.memories}，行为包 ${character.behaviors}`,
    );
  }
  if (!result.characters.length) lines.push("  （没有可迁移的角色）");
  lines.push("");
  lines.push(`合计: 角色 ${result.totals.characters}，事件 ${result.totals.events}，记忆 ${result.totals.memories}`);
  if (result.warnings.length) {
    lines.push("");
    lines.push(`警告（${result.warnings.length}）:`);
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  if (result.dryRun) {
    lines.push("");
    lines.push(`下一步: ${result.next}`);
  } else {
    lines.push("");
    lines.push(`已写 ${result.wrote.length} 个文件。`);
    lines.push(`下一步: ${result.next}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const result = await migrateFromV1({
    from: options.from,
    to: options.to,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatHuman(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    if (error?.code === "TARGET_NOT_EMPTY") {
      process.stderr.write(`迁移已停止：${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`迁移失败：${error?.message ?? error}\n`);
    if (process.env.VRLINK_MIGRATE_DEBUG) process.stderr.write(`${error?.stack ?? ""}\n`);
    process.exitCode = 1;
  });
}
