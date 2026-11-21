import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { migrateFromV1 } from "../tools/migrate-from-v1.mjs";

const TOOL = fileURLToPath(new URL("../tools/migrate-from-v1.mjs", import.meta.url));

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-migrate-"));
}

async function writeV1(root, state, { behaviors = {}, plugins = [] } = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "state.json"), `${JSON.stringify({ revision: 7, state }, null, 2)}\n`, "utf8");
  const behaviorDir = path.join(root, "behaviors");
  await fs.mkdir(behaviorDir, { recursive: true });
  for (const [name, data] of Object.entries(behaviors)) {
    await fs.writeFile(path.join(behaviorDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  for (const plugin of plugins) {
    await fs.mkdir(path.join(root, "plugins", plugin), { recursive: true });
  }
}

function linWan(overrides = {}) {
  return {
    id: "lin_wan",
    name: "林晚",
    age: 26,
    relation: "认识三个月的邻居",
    persona: { identity: "夜班护士，住在隔壁", baseline: "话少", quirks: ["先叹气"], boundaries: ["不聊工作细节"] },
    state: { mood: 0.4, energy: 0.3, trust: 0.5 },
    model: { id: "qwen3-1.7b-q4km", name: "Qwen3-1.7B", where: "本地" },
    temperature: 0.7,
    greeting: "门没关严，我听见你回来了。",
    lore: [{ when: "第 3 天", fact: "她养了一只叫豆豆的猫" }],
    license: "CC0-1.0",
    unread: 2,
    updatedAt: "2026-10-24T00:18:00+08:00",
    ...overrides,
  };
}

const CHATS = [
  { side: "time", text: "昨天 22:41" },
  { side: "in", text: "下班了。" },
  { side: "out", text: "小心点，那楼梯有一级特别高" },
  { side: "in", text: "嗯…踩到了。" },
];

function baseState() {
  return {
    me: { name: "阿钢", city: "杭州" },
    settings: {
      theme: "dark",
      engine: "local",
      api: { activeId: "deepseek", key: "sk-should-not-be-copied", profiles: [{ id: "deepseek", baseUrl: "https://api.deepseek.com" }] },
    },
    characters: [linWan()],
    currentId: "lin_wan",
    chats: { lin_wan: CHATS },
    memories: {
      lin_wan: [
        { id: "m01", text: "他叫阿钢，做前端", importance: 5, at: "第 1 天" },
        { id: "m02", text: "他生日是四月十二号", importance: 3, at: "第 26 天" },
      ],
    },
    diary: [{ id: "d01", title: "面试完", text: "面完了。", at: "10 月 21 日", visible: false }],
    models: [{ id: "gemma3-1b-q4km", name: "Gemma 3 1B IT" }],
    summaries: {},
    herState: {},
    judges: {},
    lastRoute: {},
    favorites: [],
  };
}

const BEHAVIORS = {
  "linwan--linwan-night.json": {
    version: 1,
    character: "linwan",
    packId: "linwan-night",
    current: "tired",
    vars: { tired: 1 },
    proactive: { "2026-11-01": 2 },
    idleMinutes: 7949,
    lastActivityAt: 1793515684130,
    proactiveCount: 12,
    savedAt: 1793992662558,
  },
};

async function readLines(file) {
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const FIXED_NOW = "2026-11-08T06:00:00.000Z";

test("migrate: v1 characters/chats/memories/behaviors → v2 character dir + card", async () => {
  const root = await tempDir();
  const from = path.join(root, "v1");
  const to = path.join(root, "data");
  await writeV1(from, baseState(), { behaviors: BEHAVIORS, plugins: ["v1-old-plugin"] });

  const result = await migrateFromV1({ from: [from], to, now: FIXED_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "create");
  assert.equal(result.dryRun, false);
  assert.equal(result.totals.characters, 1);
  assert.equal(result.totals.events, 3);
  assert.equal(result.totals.memories, 3); // 2 条 v1 memory + 1 条 lore

  const character = JSON.parse(await fs.readFile(path.join(to, "characters", "lin_wan", "character.json"), "utf8"));
  assert.equal(character.id, "lin_wan");
  assert.equal(character.name, "林晚");
  assert.equal(character.persona.identity, "夜班护士，住在隔壁");
  assert.equal(character.persona.baseline, "话少");
  assert.deepEqual(character.persona.quirks, ["先叹气"]);
  assert.equal(character.brain.engine, "mock");
  assert.equal(character.brain.model, "qwen3-1.7b-q4km");
  assert.equal(character["x-vrlink"].migration.originalId, "lin_wan");
  assert.equal(character["x-vrlink"].v1.character.license, "CC0-1.0");
  assert.equal(character["x-vrlink"].v1.behaviors[0].packId, "linwan-night");

  const state = JSON.parse(await fs.readFile(path.join(to, "characters", "lin_wan", "state.json"), "utf8"));
  assert.equal(state.eventCount, 3);
  assert.equal(state.mood, "愉快");
  assert.equal(state.energy, 0.3);
  assert.equal(state.trust, 0.5);
  assert.equal(state.unread, 2);
  assert.equal(state.lastEventType, "message.sent");

  const events = await readLines(path.join(to, "characters", "lin_wan", "events.jsonl"));
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.type), ["message.sent", "message.received", "message.sent"]);
  assert.equal(events[0].content.text, "下班了。");
  assert.equal(events[0].content.v1Time, "昨天 22:41"); // 时间分隔线保留到下一条消息
  assert.equal(events[1].source.actor.id, "owner");
  assert.ok(events.every((event) => event.characterId === "lin_wan" && event.visibility === "private"));

  const memories = await readLines(path.join(to, "characters", "lin_wan", "memory", "memory.jsonl"));
  assert.equal(memories.length, 3);
  assert.equal(memories[0].source, "v1:migrate");
  assert.equal(memories[0].confidence, 1); // importance 5 / 5
  assert.equal(memories[2].source, "v1:lore");
  assert.equal(memories[2].text, "她养了一只叫豆豆的猫");

  const card = JSON.parse(await fs.readFile(path.join(to, "cards", "lin_wan.card.json"), "utf8"));
  assert.equal(card.source.kind, "vrlink-v1-migration");
  assert.equal(card.behaviors.length, 1);
  assert.equal(card.behaviors[0].current, "tired");

  const marker = JSON.parse(await fs.readFile(path.join(to, ".vrlink-migration.json"), "utf8"));
  assert.equal(marker.fingerprint, result.fingerprint);
  assert.equal(marker.characters[0].events, 3);

  const appState = JSON.parse(await fs.readFile(path.join(to, "migration", "v1-app-state.json"), "utf8"));
  assert.equal(appState.sources[0].settings.api.key, "[redacted]");
  assert.equal(appState.sources[0].settings.theme, "dark");
  assert.deepEqual(appState.sources[0].plugins.files, ["v1-old-plugin"]);
  assert.equal(appState.sources[0].diary[0].title, "面试完");
  assert.equal(result.warnings.some((warning) => warning.includes("plugins/")), true);
});

test("dry-run: prints the plan and writes nothing", async () => {
  const root = await tempDir();
  const from = path.join(root, "v1");
  const to = path.join(root, "data-not-created");
  await writeV1(from, baseState(), { behaviors: BEHAVIORS });

  const before = await fs.readdir(root);
  const result = await migrateFromV1({ from: [from], to, dryRun: true, now: FIXED_NOW });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.wrote, []);
  assert.equal(result.totals.characters, 1);
  assert.match(result.next, /目标为空/);
  assert.deepEqual(await fs.readdir(root), before);
  await assert.rejects(fs.access(to));
});

test("target protection: non-empty target refused, --overwrite keeps unrelated data", async () => {
  const root = await tempDir();
  const from = path.join(root, "v1");
  const to = path.join(root, "data");
  await writeV1(from, baseState(), { behaviors: BEHAVIORS });

  await fs.mkdir(path.join(to, "characters", "someone_else"), { recursive: true });
  await fs.writeFile(path.join(to, "characters", "someone_else", "character.json"), '{"id":"someone_else"}\n', "utf8");
  await fs.writeFile(path.join(to, "keep.txt"), "keep me\n", "utf8");

  await assert.rejects(
    () => migrateFromV1({ from: [from], to, now: FIXED_NOW }),
    (error) => error.code === "TARGET_NOT_EMPTY" && /--overwrite/.test(error.message),
  );
  // 拒绝时不能留下任何迁移产物
  await assert.rejects(fs.access(path.join(to, "characters", "lin_wan")));

  // 模拟上次迁移留下的旧文件：--overwrite 应只替换本次角色目录
  await fs.mkdir(path.join(to, "characters", "lin_wan"), { recursive: true });
  await fs.writeFile(path.join(to, "characters", "lin_wan", "stale.txt"), "stale\n", "utf8");

  const result = await migrateFromV1({ from: [from], to, overwrite: true, now: FIXED_NOW });
  assert.equal(result.mode, "overwrite");
  assert.equal(await fs.readFile(path.join(to, "keep.txt"), "utf8"), "keep me\n");
  assert.equal(await fs.readFile(path.join(to, "characters", "someone_else", "character.json"), "utf8"), '{"id":"someone_else"}\n');
  await assert.rejects(fs.access(path.join(to, "characters", "lin_wan", "stale.txt")));
  await fs.access(path.join(to, "characters", "lin_wan", "character.json"));
});

test("idempotent re-run: same source produces byte-identical files, no duplicate events", async () => {
  const root = await tempDir();
  const from = path.join(root, "v1");
  const to = path.join(root, "data");
  await writeV1(from, baseState(), { behaviors: BEHAVIORS });

  const first = await migrateFromV1({ from: [from], to, now: FIXED_NOW });
  const snapshot = {};
  for (const relative of [
    "characters/lin_wan/character.json",
    "characters/lin_wan/state.json",
    "characters/lin_wan/events.jsonl",
    "characters/lin_wan/memory/memory.jsonl",
    "cards/lin_wan.card.json",
  ]) {
    snapshot[relative] = await fs.readFile(path.join(to, relative), "utf8");
  }

  const second = await migrateFromV1({ from: [from], to, now: FIXED_NOW });
  assert.equal(second.mode, "rerun");
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.totals.events, first.totals.events);
  for (const [relative, content] of Object.entries(snapshot)) {
    assert.equal(await fs.readFile(path.join(to, relative), "utf8"), content, `应保持字节一致: ${relative}`);
  }
  const events = await readLines(path.join(to, "characters", "lin_wan", "events.jsonl"));
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
});

test("multi-source merge: identical blocks are skipped once, extra proactive chats preserved", async () => {
  const root = await tempDir();
  const sourceA = path.join(root, "hub");
  const sourceB = path.join(root, "desktop");
  const to = path.join(root, "data");

  const stateA = baseState();
  await writeV1(sourceA, stateA, { behaviors: BEHAVIORS });

  const stateB = baseState();
  stateB.characters = [linWan()];
  stateB.chats = {
    lin_wan: CHATS,
    linwan: [
      { side: "in", text: "在忙吗？突然想跟你说句话。", proactive: true, at: 1793518384494 },
      { side: "in", text: "没什么事，就是想起你了。", proactive: true, at: 1793518444502 },
    ],
  };
  await writeV1(sourceB, stateB);

  const result = await migrateFromV1({ from: [sourceA, sourceB], to, now: FIXED_NOW });
  assert.equal(result.totals.characters, 1);
  // A 的 3 条 + B 的完全相同 3 条被跳过 + B 的 2 条主动消息
  assert.equal(result.totals.events, 5);
  assert.ok(result.warnings.some((warning) => warning.includes("跳过重复聊天块")));
  assert.ok(result.warnings.some((warning) => warning.includes("跳过重复记忆块")));

  const events = await readLines(path.join(to, "characters", "lin_wan", "events.jsonl"));
  assert.equal(events.length, 5);
  assert.equal(events.filter((event) => event.content.proactive).length, 2);
  assert.equal(new Set(events.map((event) => event.id)).size, 5);
  const state = JSON.parse(await fs.readFile(path.join(to, "characters", "lin_wan", "state.json"), "utf8"));
  assert.equal(state.eventCount, events.length);
});

test("invalid source: missing v1 state shape is rejected", async () => {
  const root = await tempDir();
  const from = path.join(root, "broken");
  await fs.mkdir(from, { recursive: true });
  await fs.writeFile(path.join(from, "state.json"), '{"revision":1}\n', "utf8");
  await assert.rejects(
    () => migrateFromV1({ from: [from], to: path.join(root, "data") }),
    /不支持的 v1 state 结构/,
  );
});

test("CLI: node tools/migrate-from-v1.mjs --dry-run --json works one-shot", async () => {
  const root = await tempDir();
  const from = path.join(root, "v1");
  const to = path.join(root, "data");
  await writeV1(from, baseState(), { behaviors: BEHAVIORS });

  const run = spawnSync(
    process.execPath,
    [TOOL, "--from", from, "--to", to, "--dry-run", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.totals.characters, 1);
  await assert.rejects(fs.access(to));
});
