import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { CharacterStore } from "../src/character-store.mjs";
import { EventLog, makeEvent } from "../src/event-log.mjs";
import { ConsentService } from "../src/consent.mjs";
import { AuditLog } from "../src/audit.mjs";
import { CapabilityBus, ConsentRequiredError, registerBuiltins } from "../src/capability-bus.mjs";
import { CharacterActor } from "../src/actor.mjs";
import { createMockBrain } from "../src/brains/mock.mjs";
import { validatePluginManifest, validateCharacter } from "../src/contracts.mjs";
import { scanPlugins } from "../src/plugin-manifest.mjs";
import { createHub } from "../src/server.mjs";
import { HomeAssistantAdapter } from "../src/adapters/home-assistant.mjs";
import { EngineScheduler } from "../src/scheduler.mjs";
import { createOneBotBridge, normalizeOneBotEvent } from "../src/adapters/onebot-bridge.mjs";
import { createBilibiliBridge, normalizeBilibiliEvent } from "../src/adapters/bilibili-bridge.mjs";
import { buildContext } from "../src/context.mjs";
import { parseDshpetFile, importDshpet, summarizePack } from "../src/import/dshpet.mjs";
import { createOpenAIBrain } from "../src/brains/openai.mjs";
import { createLocalBrain } from "../src/brains/local.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-v2-"));
}

test("event log: append, read, replay, per-character isolation", async () => {
  const root = await tempDir();
  const log = new EventLog(path.join(root, "characters"));
  const a = await log.append("a", { type: "message.received", source: { body: "desktop" }, content: { text: "hi" } });
  const b = await log.append("b", { type: "message.received", source: { body: "qq" }, content: { text: "yo" } });
  assert.equal(a.characterId, "a");
  assert.equal(b.characterId, "b");
  const aEvents = await log.read("a");
  assert.equal(aEvents.length, 1);
  assert.equal(aEvents[0].content.text, "hi");
  const count = await log.replay("a", (n, event) => n + (event.type === "message.received" ? 1 : 0), 0);
  assert.equal(count, 1);
});

test("character store: create, list, export, import", async () => {
  const root = await tempDir();
  const store = new CharacterStore(path.join(root, "characters"));
  await store.init({ seed: false });
  const created = await store.create({
    id: "a_du",
    name: "阿渡",
    persona: { identity: "向导", baseline: "话少" },
    brain: { engine: "mock", model: "mock" },
  });
  assert.equal(created.id, "a_du");
  const list = await store.list();
  assert.equal(list.length, 1);
  await store.updateState("a_du", { mood: "平静" });
  assert.equal((await store.state("a_du")).mood, "平静");
  const memory = await store.appendMemory("a_du", { text: "她喜欢雨天" });
  assert.equal(memory.text, "她喜欢雨天");
  assert.equal((await store.listMemory("a_du")).length, 1);

  const exportDir = path.join(root, "exported");
  await store.exportTo("a_du", exportDir);
  await store.remove("a_du");
  assert.equal((await store.list()).length, 0);
  const imported = await store.importFrom(exportDir);
  assert.equal(imported.id, "a_du");
  assert.equal((await store.load("a_du")).name, "阿渡");
  assert.equal((await store.listMemory("a_du")).length, 1);
});

test("consent: low auto, high requires approval and one-shot", async () => {
  const root = await tempDir();
  const consent = await new ConsentService(path.join(root, "consent.json")).init();
  const low = await consent.grant({ characterId: "a", scope: "character:a", actions: ["message.send"], riskMax: "low" });
  assert.equal(consent.check({ characterId: "a", action: "message.send", risk: "low" }).ok, true);
  const high = consent.check({ characterId: "a", action: "device.command", risk: "high" });
  assert.equal(high.ok, false);
  assert.equal(high.requiresApproval, true);
  assert.equal(await consent.consume(low.id, { characterId: "a", action: "message.send" }), true);
  assert.equal((await consent.revoke(low.id)).ok, true);
  assert.equal(consent.check({ characterId: "a", action: "message.send", risk: "low" }).ok, false);
  assert.equal(Boolean(high), true);
});

test("capability bus: low risk passes, high risk needs approval token", async () => {
  const root = await tempDir();
  const consent = await new ConsentService(path.join(root, "consent.json")).init();
  await consent.grant({ characterId: "a", scope: "character:a", actions: ["message.send"], riskMax: "low" });
  const audit = new AuditLog(path.join(root, "characters"));
  const bus = new CapabilityBus({ consent, audit });
  let called = 0;
  bus.register(
    { name: "message.send", description: "send", params: {}, risk: "low" },
    async () => {
      called += 1;
      return { ok: true };
    },
  );
  bus.register(
    { name: "device.command", description: "device", params: {}, risk: "high", requiresConsent: true },
    async () => ({ ok: true }),
  );
  assert.deepEqual(await bus.invoke({ characterId: "a", name: "message.send", params: {} }), { ok: true });
  assert.equal(called, 1);
  await assert.rejects(
    () => bus.invoke({ characterId: "a", name: "device.command", params: {} }),
    (error) => error instanceof ConsentRequiredError && error.code === "CONSENT_REQUIRED",
  );
  const ask = await consent.request({ characterId: "a", action: "device.command", risk: "high", reason: "test" });
  const grant = await consent.approve(ask.id);
  const result = await bus.invoke({ characterId: "a", name: "device.command", params: {}, approvalToken: grant.id });
  assert.deepEqual(result, { ok: true });
});

test("actor: one character, serial queue, mock reply", async () => {
  const root = await tempDir();
  const store = new CharacterStore(path.join(root, "characters"));
  await store.init({ seed: false });
  await store.create({ id: "a_du", name: "阿渡", persona: { identity: "向导" }, brain: { engine: "mock" } });
  const eventLog = new EventLog(path.join(root, "characters"));
  const consent = await new ConsentService(path.join(root, "consent.json")).init();
  await consent.grant({ characterId: "a_du", scope: "character:a_du", actions: ["message.send"], riskMax: "low" });
  const audit = new AuditLog(path.join(root, "characters"));
  const bus = new CapabilityBus({ consent, audit });
  registerBuiltins({ bus, store, eventLog });
  const actor = new CharacterActor({ character: await store.load("a_du"), store, eventLog, capabilities: bus, brain: createMockBrain() });
  const result = await actor.enqueue(makeEvent({
    characterId: "a_du",
    type: "message.received",
    body: "desktop",
    content: { text: "今天好累" },
  }));
  assert.equal(result.produced.some((event) => event.type === "message.sent"), true);
  const reply = result.produced.find((event) => event.type === "message.sent");
  assert.match(reply.content.text, /坐下|累|嗯/);
  assert.equal((await store.state("a_du")).eventCount, 1);
});

test("plugin manifest: validate + scan", async () => {
  const root = await tempDir();
  const pluginDir = path.join(root, "plugins", "hello");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    id: "hello", type: "code", apiVersion: 1, version: "0.1.0", name: "Hello",
    entry: "index.mjs", permissions: ["events.read"], capabilities: [], risk: "low", license: "MIT",
  }), "utf8");
  // 2026-11-08：scan 现在会校验入口文件必须存在且留在插件目录内
  await fs.writeFile(path.join(pluginDir, "index.mjs"), "export default {};\n", "utf8");
  const scanned = await scanPlugins(path.join(root, "plugins"));
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].manifest.id, "hello");
  assert.throws(() => validatePluginManifest({ id: "x", type: "bad", version: "1.0.0", apiVersion: 1, name: "x", entry: "x" }));
  assert.throws(() => validateCharacter({ id: "x", name: "" }));
});

test("devices: low-risk auto, high-risk needs approval, state changes", async () => {
  const root = await tempDir();
  const store = new CharacterStore(path.join(root, "characters"));
  await store.init({ seed: false });
  await store.create({ id: "a_du", name: "阿渡", persona: { identity: "向导" }, brain: { engine: "mock" } });
  const eventLog = new EventLog(path.join(root, "characters"));
  const consent = await new ConsentService(path.join(root, "consent.json")).init();
  await consent.grant({ characterId: "a_du", scope: "character:a_du", actions: ["device.command", "device.list"], riskMax: "low" });
  const audit = new AuditLog(path.join(root, "characters"));
  const bus = new CapabilityBus({ consent, audit });
  const home = new (await import("../src/devices.mjs")).VirtualHome({ seedDemo: true });
  registerBuiltins({ bus, store, eventLog, home });

  const curtain = await bus.invoke({
    characterId: "a_du",
    name: "device.command",
    params: { deviceId: "living_room_curtain", command: "close" },
  });
  assert.equal(curtain.ok, true);
  assert.equal(home.get("living_room_curtain").state.position, 0);

  await assert.rejects(
    () => bus.invoke({ characterId: "a_du", name: "device.command", params: { deviceId: "front_door_lock", command: "unlock" } }),
    (error) => error instanceof ConsentRequiredError && error.detail?.risk === "high",
  );
  const ask = await consent.request({ characterId: "a_du", action: "device.command", risk: "high", reason: "test unlock" });
  const grant = await consent.approve(ask.id);
  const unlock = await bus.invoke({
    characterId: "a_du",
    name: "device.command",
    params: { deviceId: "front_door_lock", command: "unlock" },
    approvalToken: grant.id,
  });
  assert.equal(unlock.ok, true);
  assert.equal(home.get("front_door_lock").state.locked, false);
  const auditRows = await audit.list("a_du");
  assert.ok(auditRows.some((row) => row.action === "device.command" && row.risk === "high"));
});

test("server: AGI port, simulated QQ body, multi-character isolation", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const discovery = await (await fetch(`${base}/.well-known/vrlink.json`)).json();
    assert.equal(discovery.name, "vrlink");
    assert.ok(discovery.protocols.includes("sse"));

    const caps = await (await fetch(`${base}/v1/capabilities`)).json();
    assert.ok(caps.capabilities.some((cap) => cap.name === "device.command"));

    const characters = await (await fetch(`${base}/api/characters`)).json();
    const id = characters.characters[0].id;

    const say = await (await fetch(`${base}/v1/characters/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "message.send", params: { text: "AGI 说你好" }, reason: "test" }),
    })).json();
    assert.equal(say.ok, true);

    await fetch(`${base}/api/characters/${id}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "qq", thread: "group:demo", text: "QQ 上有人问在吗", visibility: "group" }),
    });
    const events = await (await fetch(`${base}/api/characters/${id}/events`)).json();
    assert.ok(events.events.some((event) => event.source?.body === "qq" && event.content?.text === "QQ 上有人问在吗"));
    assert.ok(events.events.some((event) => event.type === "message.sent" && event.source?.body === "qq"));

    const created = await (await fetch(`${base}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "xiao_man", name: "小满", persona: { identity: "新朋友" }, brain: { engine: "mock" } }),
    })).json();
    assert.equal(created.ok, true);
    await fetch(`${base}/api/characters/xiao_man/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "小满在吗" }),
    });
    const xiao = await (await fetch(`${base}/api/characters/xiao_man/events`)).json();
    assert.ok(xiao.events.some((event) => event.content?.text === "小满在吗"));
    const lin = await (await fetch(`${base}/api/characters/${id}/events`)).json();
    assert.equal(lin.events.some((event) => event.content?.text === "小满在吗"), false);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("Home Assistant adapter: discover, map risks, call service", async () => {
  const calls = [];
  const states = [
    { entity_id: "light.living_room", state: "off", attributes: { friendly_name: "客厅灯", brightness: 0 } },
    { entity_id: "cover.living_room", state: "closed", attributes: { friendly_name: "客厅窗帘", current_position: 0 } },
    { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "大门锁" } },
  ];
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/states" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(states));
    }
    if (url.pathname === "/api/services/light/turn_on" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({ path: url.pathname, body });
      const updated = states.map((state) => state.entity_id === body.entity_id ? { ...state, state: "on", attributes: { ...state.attributes, brightness: 255 } } : state);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(updated));
    }
    if (url.pathname.startsWith("/api/states/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/states/".length));
      const found = states.find((state) => state.entity_id === id);
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(found ?? { error: "not found" }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = fake.address().port;
  try {
    const adapter = await new HomeAssistantAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
    }).init();
    const list = adapter.list();
    assert.equal(list.length, 3);
    assert.equal(adapter.riskFor("lock.front_door", "unlock"), "high");
    assert.equal(adapter.riskFor("cover.living_room", "close_cover"), "low");
    const result = await adapter.command("light.living_room", "turn_on", {});
    assert.equal(result.ok, true);
    assert.equal(result.device.state.on, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.entity_id, "light.living_room");

    const hub = await createHub({
      dataDir: await tempDir(),
      uiDir: path.join(process.cwd(), "ui"),
      pluginsDir: path.join(process.cwd(), "plugins"),
      home: adapter,
    });
    await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
    const address = hub.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const characters = await (await fetch(`${base}/api/characters`)).json();
      const id = characters.characters[0].id;
      const devices = await (await fetch(`${base}/api/devices`)).json();
      assert.ok(devices.devices.some((device) => device.id === "light.living_room"));
      const command = await (await fetch(`${base}/api/devices/light.living_room/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: id, command: "turn_on" }),
      })).json();
      assert.equal(command.ok, true);
    } finally {
      await hub.pluginHost.close();
      await new Promise((resolve) => hub.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("OpenAI-compatible endpoint uses the character brain", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(models.data.some((model) => model.id === "vrlink:lin_wan"));
    const response = await (await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "vrlink:lin_wan",
        messages: [{ role: "user", content: "在吗" }],
      }),
    })).json();
    assert.equal(response.object, "chat.completion");
    assert.equal(typeof response.choices[0].message.content, "string");
    assert.match(response.choices[0].message.content, /在|嗯|刚醒/);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("scheduler: API runs concurrently, local serializes", async () => {
  const scheduler = new EngineScheduler({ apiConcurrency: 2, localConcurrency: 1 });
  let apiActive = 0;
  let apiMax = 0;
  const apiJob = () => new Promise((resolve) => {
    apiActive += 1;
    apiMax = Math.max(apiMax, apiActive);
    setTimeout(() => {
      apiActive -= 1;
      resolve("api");
    }, 40);
  });
  await Promise.all([
    scheduler.run({ engine: "api", characterId: "a" }, apiJob),
    scheduler.run({ engine: "api", characterId: "b" }, apiJob),
  ]);
  assert.equal(apiMax, 2);

  let localActive = 0;
  let localMax = 0;
  const localJob = () => new Promise((resolve) => {
    localActive += 1;
    localMax = Math.max(localMax, localActive);
    setTimeout(() => {
      localActive -= 1;
      resolve("local");
    }, 30);
  });
  await Promise.all([
    scheduler.run({ engine: "local", characterId: "a" }, localJob),
    scheduler.run({ engine: "local", characterId: "b" }, localJob),
  ]);
  assert.equal(localMax, 1);
  const status = scheduler.status();
  assert.equal(status.api.done >= 2, true);
  assert.equal(status.local.done >= 2, true);
});

test("server: safe mode and plugin storage control", async () => {
  const root = await tempDir();
  const pluginsDir = path.join(process.cwd(), "plugins");
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir, homeDemo: true });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const plugins = await (await fetch(`${base}/api/plugins`)).json();
    const plugin = plugins.plugins.find((item) => item.id === "hello-memory");
    assert.ok(plugin);
    const enabled = await (await fetch(`${base}/api/plugins/hello-memory/enable`, { method: "POST" })).json();
    assert.equal(enabled.ok, true);
    await fs.mkdir(path.join(root, "plugins", "hello-memory"), { recursive: true });
    await fs.writeFile(path.join(root, "plugins", "hello-memory", "storage.json"), JSON.stringify({ note: "hello" }), "utf8");
    const storage = await (await fetch(`${base}/api/plugins/hello-memory/storage`)).json();
    assert.equal(storage.data.note, "hello");
    const purged = await (await fetch(`${base}/api/plugins/hello-memory/storage`, { method: "DELETE" })).json();
    assert.equal(purged.ok, true);

    const safe = await (await fetch(`${base}/api/safe-mode`, { method: "POST" })).json();
    assert.equal(safe.safeMode, true);
    const after = await (await fetch(`${base}/api/plugins`)).json();
    assert.equal(after.plugins.find((item) => item.id === "hello-memory").enabled, false);
    const chars = await (await fetch(`${base}/api/characters`)).json();
    const id = chars.characters[0].id;
    const blocked = await fetch(`${base}/api/devices/living_room_curtain/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: id, command: "close" }),
    });
    assert.equal(blocked.status, 503);
    const off = await (await fetch(`${base}/api/safe-mode/off`, { method: "POST" })).json();
    assert.equal(off.safeMode, false);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("overview: per-character usage, queue and budget flag", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await (await fetch(`${base}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "tiny_budget",
        name: "小预算",
        persona: { identity: "测试" },
        brain: { engine: "mock" },
        budget: { turnsPerDay: 1, tokensPerDay: 100000 },
      }),
    })).json();
    assert.equal(created.ok, true);
    await fetch(`${base}/api/characters/tiny_budget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.ok(overview.characters.length >= 2);
    const tiny = overview.characters.find((character) => character.id === "tiny_budget");
    assert.equal(tiny.state.usage.turns, 1);
    assert.equal(tiny.state.overBudget, true);
    assert.ok(overview.scheduler.api.limit >= 1);
    assert.equal(typeof overview.todayTokens, "number");
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("MCP server: initialize, tools/list, tools/call chat", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [path.join(process.cwd(), "src", "mcp-server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, VRLINK_HUB_URL: base },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`mcp timeout: ${method}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const initialize = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
    assert.equal(initialize.serverInfo.name, "vrlink");
    const tools = await rpc("tools/list", {});
    assert.ok(tools.tools.some((tool) => tool.name === "vrlink_chat"));
    const characters = await rpc("tools/call", { name: "vrlink_list_characters", arguments: {} });
    const characterList = JSON.parse(characters.content[0].text);
    assert.ok(characterList.characters.length >= 1);
    const id = characterList.characters[0].id;
    const chat = await rpc("tools/call", { name: "vrlink_chat", arguments: { characterId: id, text: "在吗" } });
    const chatResult = JSON.parse(chat.content[0].text);
    assert.equal(chatResult.ok, true);
    assert.equal(typeof chatResult.reply, "string");
  } finally {
    child.kill();
    await new Promise((resolve) => hub.pluginHost.close().then(resolve));
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("budget: stop and mute policies, budget patch", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${base}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "stop_fish", name: "停", persona: { identity: "测试" }, brain: { engine: "mock" }, budget: { turnsPerDay: 1, overLimit: "stop" } }),
    });
    const first = await fetch(`${base}/api/characters/stop_fish/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/characters/stop_fish/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "还在吗" }),
    });
    assert.equal(second.status, 429);
    const secondBody = await second.json();
    assert.equal(secondBody.code, "BUDGET_EXCEEDED");

    const patched = await (await fetch(`${base}/api/characters/stop_fish/budget`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnsPerDay: 10, overLimit: "warn" }),
    })).json();
    assert.equal(patched.ok, true);
    assert.equal(patched.budget.overLimit, "warn");
    const third = await fetch(`${base}/api/characters/stop_fish/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "再来" }),
    });
    assert.equal(third.status, 200);

    await fetch(`${base}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mute_fish", name: "静", persona: { identity: "测试" }, brain: { engine: "mock" }, budget: { turnsPerDay: 1, overLimit: "mute" } }),
    });
    await fetch(`${base}/api/characters/mute_fish/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    const muted = await (await fetch(`${base}/api/characters/mute_fish/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "还在吗" }),
    })).json();
    assert.equal(muted.ok, true);
    assert.equal(muted.reply, "");
    const muteState = await (await fetch(`${base}/api/characters/mute_fish`)).json();
    assert.equal(muteState.state.overBudget, true);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("import: SOUL.md + memory text becomes a character and memories", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const imported = await (await fetch(`${base}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        soulText: "# 小雨\n夜班护士，话少，会先叹气。\n不喜欢被叫老师。",
        memoryText: "# 记忆\n她喜欢雨天。\n她记得我下周三复查。",
      }),
    })).json();
    assert.equal(imported.ok, true);
    assert.equal(imported.character.name, "小雨");
    assert.match(imported.character.persona.identity, /夜班护士/);
    assert.equal(imported.importedMemories, 2);
    const memory = await (await fetch(`${base}/api/characters/${imported.character.id}/memory`)).json();
    assert.equal(memory.memory.length, 2);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("OneBot bridge: webhook event becomes QQ life event and reply is sent back", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubAddress = hub.server.address();
  const hubBase = `http://127.0.0.1:${hubAddress.port}`;

  const sent = [];
  const fakeOneBot = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    sent.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise((resolve) => fakeOneBot.listen(0, "127.0.0.1", resolve));
  const onebotBase = `http://127.0.0.1:${fakeOneBot.address().port}`;

  const bridge = await createOneBotBridge({
    hubUrl: hubBase,
    characterId: "lin_wan",
    onebotApiBase: onebotBase,
    port: 0,
    host: "127.0.0.1",
  });
  try {
    assert.equal(normalizeOneBotEvent({ post_type: "message", message_type: "private", user_id: 1, self_id: 2, raw_message: "在吗" }).thread, "private:1");
    assert.equal(normalizeOneBotEvent({ post_type: "message", message_type: "private", user_id: 2, self_id: 2, raw_message: "自己" }), null);

    const webhook = `http://127.0.0.1:${bridge.port}/onebot`;
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: 1001,
        self_id: 9999,
        raw_message: "在吗",
        sender: { nickname: "阿哲" },
      }),
    });
    assert.equal(response.status, 200);
    let found = null;
    for (let i = 0; i < 40; i += 1) {
      found = sent.find((item) => item.url === "/send_private_msg");
      if (found) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(found);
    assert.equal(found.body.user_id, 1001);
    assert.equal(typeof found.body.message, "string");
    assert.ok(found.body.message.length > 0);

    const events = await (await fetch(`${hubBase}/api/characters/lin_wan/events`)).json();
    assert.ok(events.events.some((event) => event.source?.body === "qq" && event.content?.text === "在吗"));
  } finally {
    await bridge.close();
    await new Promise((resolve) => fakeOneBot.close(resolve));
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("server: device command + consent request flow", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins"), homeDemo: true });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const characters = await (await fetch(`${base}/api/characters`)).json();
    const id = characters.characters[0].id;
    const devices = await (await fetch(`${base}/api/devices`)).json();
    assert.ok(devices.devices.some((device) => device.id === "living_room_curtain"));
    const low = await (await fetch(`${base}/api/devices/living_room_curtain/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: id, command: "close" }),
    })).json();
    assert.equal(low.ok, true);

    const high = await fetch(`${base}/api/devices/front_door_lock/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: id, command: "unlock" }),
    });
    assert.equal(high.status, 403);
    const highBody = await high.json();
    assert.equal(highBody.code, "CONSENT_REQUIRED");
    assert.ok(highBody.requestId);

    const approved = await (await fetch(`${base}/api/consent/requests/${highBody.requestId}/approve`, { method: "POST" })).json();
    assert.equal(approved.ok, true);
    const retry = await (await fetch(`${base}/api/devices/front_door_lock/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: id, command: "unlock", approvalToken: approved.grant.id }),
    })).json();
    assert.equal(retry.ok, true);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("server: health, characters, chat", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    const characters = await (await fetch(`${base}/api/characters`)).json();
    assert.ok(characters.characters.length >= 1);
    const id = characters.characters[0].id;
    const chat = await (await fetch(`${base}/api/characters/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    })).json();
    assert.equal(chat.ok, true);
    assert.equal(typeof chat.reply, "string");
    const events = await (await fetch(`${base}/api/characters/${id}/events`)).json();
    assert.ok(events.events.length >= 2);
  } finally {
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("plugin host: child process receives event and sends a message", async () => {
  const root = await tempDir();
  const pluginsDir = path.join(root, "plugins", "echo");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, "plugin.json"), JSON.stringify({
    id: "echo",
    type: "code",
    apiVersion: 1,
    version: "0.1.0",
    name: "回声",
    entry: "index.mjs",
    permissions: ["events.read", "messages.send"],
    capabilities: [],
    risk: "low",
    license: "MIT",
  }), "utf8");
  await fs.writeFile(path.join(pluginsDir, "index.mjs"), `
export default function activate(api) {
  api.on("event", async (name, payload) => {
    if (payload?.type !== "message.received") return;
    api.send({ characterId: payload.characterId, text: "插件回声" });
  });
}
`, "utf8");

  const hub = await createHub({
    dataDir: path.join(root, "data"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir: path.join(root, "plugins"),
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const characters = await (await fetch(`${base}/api/characters`)).json();
    const id = characters.characters[0].id;
    const plugins = await (await fetch(`${base}/api/plugins`)).json();
    assert.equal(plugins.plugins.length, 1);
    const enabled = await (await fetch(`${base}/api/plugins/echo/enable`, { method: "POST" })).json();
    assert.equal(enabled.ok, true);
    await fetch(`${base}/api/characters/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    let found = false;
    for (let i = 0; i < 30; i += 1) {
      const data = await (await fetch(`${base}/api/characters/${id}/events`)).json();
      found = data.events.some((event) => event.type === "message.sent" && event.content?.text === "插件回声");
      if (found) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(found, true);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("Bilibili bridge: draft-only, never auto-sends", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const hubAddress = hub.server.address();
  const hubBase = `http://127.0.0.1:${hubAddress.port}`;
  const bridge = await createBilibiliBridge({ hubUrl: hubBase, characterId: "lin_wan", port: 0 });
  try {
    assert.equal(normalizeBilibiliEvent({ type: "dm", text: "私信" }).visibility, "private");
    const response = await fetch(`http://127.0.0.1:${bridge.port}/bili`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "comment", text: "这条鱼好可爱", user: { id: "42", name: "路人" } }),
    });
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, "draft-only");
    assert.equal(typeof data.draft, "string");
    assert.ok(data.draft.length > 0);

    const events = await (await fetch(`${hubBase}/api/characters/lin_wan/events`)).json();
    assert.ok(events.events.some((event) => event.type === "message.draft" && event.source?.body === "bili" && event.visibility === "public"));
    assert.equal(events.events.some((event) => event.type === "message.sent" && event.source?.body === "bili"), false);
  } finally {
    await bridge.close();
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("A2A agent card is discoverable", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const discovery = await (await fetch(`${base}/.well-known/vrlink.json`)).json();
    assert.ok(discovery.protocols.includes("a2a"));
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(card.name, "VRlink");
    assert.ok(card.skills.some((skill) => skill.id === "devices"));
    assert.ok(card.skills.some((skill) => skill.id === "chat"));
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("A2A JSON-RPC: message/send, tasks/get, stream", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const send = await (await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "在吗" }] } },
      }),
    })).json();
    assert.equal(send.result.status.state, "completed");
    assert.ok(send.result.artifacts[0].parts[0].text.length > 0);
    const taskId = send.result.id;
    const get = await (await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: taskId } }),
    })).json();
    assert.equal(get.result.id, taskId);
    const cancel = await (await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id: taskId } }),
    })).json();
    assert.equal(cancel.result.status.state, "canceled");

    const stream = await (await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "message/stream",
        params: { message: { role: "user", parts: [{ kind: "text", text: "在吗" }] } },
      }),
    })).text();
    assert.match(stream, /event: message/);
    assert.match(stream, /\[DONE\]/);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("WebSocket life stream pushes events", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/characters/lin_wan`);
  const messages = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data));
  });
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const waitFor = async (predicate) => {
      for (let i = 0; i < 60; i += 1) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    assert.equal(await waitFor(() => messages.some((item) => item.type === "snapshot")), true);
    await fetch(`${base}/api/characters/lin_wan/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    assert.equal(
      await waitFor(() => messages.some((item) => item.type === "event" && item.event?.type === "message.sent")),
      true,
    );
  } finally {
    ws.close();
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("privacy: public context excludes private/internal events and memories", () => {
  const events = [
    { id: "p", visibility: "public" },
    { id: "g", visibility: "group" },
    { id: "x", visibility: "private" },
    { id: "i", visibility: "internal" },
  ];
  const memories = [
    { id: "mp", visibility: "public" },
    { id: "mx", visibility: "private" },
  ];
  const pub = buildContext({ events, memories, requestVisibility: "public" });
  assert.deepEqual(pub.events.map((event) => event.id), ["p"]);
  assert.deepEqual(pub.memories.map((memory) => memory.id), ["mp"]);
  const group = buildContext({ events, memories, requestVisibility: "group" });
  assert.deepEqual(group.events.map((event) => event.id), ["p", "g"]);
  const priv = buildContext({ events, memories, requestVisibility: "private" });
  assert.deepEqual(priv.events.map((event) => event.id), ["p", "g", "x"]);
  assert.deepEqual(priv.memories.map((memory) => memory.id), ["mp", "mx"]);
  const internal = buildContext({ events, memories, requestVisibility: "internal" });
  assert.equal(internal.events.length, 4);
});

test("hardening: rate limit returns 429, replay reads event log", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins"), rateLimit: 2, rateLimitLoopback: false });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${base}/api/characters`);
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    const third = await (await fetch(`${base}/api/characters`)).json();
    assert.equal(third.code, "RATE_LIMITED");

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    // fresh hub to avoid the rate limit when testing replay
    const hub2 = await createHub({ dataDir: path.join(root, "replay"), uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
    await new Promise((resolve) => hub2.server.listen(0, "127.0.0.1", resolve));
    const base2 = `http://127.0.0.1:${hub2.server.address().port}`;
    try {
      await fetch(`${base2}/api/characters/lin_wan/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "在吗" }),
      });
      const replay = await (await fetch(`${base2}/api/characters/lin_wan/replay`)).json();
      assert.equal(replay.ok, true);
      assert.ok(replay.eventCount >= 2);
      assert.ok(replay.types["message.received"] >= 1);
      assert.ok(replay.types["message.sent"] >= 1);
    } finally {
      await hub2.pluginHost.close();
      await new Promise((resolve) => hub2.server.close(resolve));
    }
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("ACP server: initialize, session/new, session/prompt", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [path.join(process.cwd(), "src", "acp-server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, VRLINK_HUB_URL: base, VRLINK_CHARACTER_ID: "lin_wan" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const notifications = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === "session/update") {
      notifications.push(message.params);
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`acp timeout: ${method}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const initialized = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(initialized.protocolVersion, 1);
    const session = await rpc("session/new", { cwd: process.cwd(), metadata: { characterId: "lin_wan" } });
    assert.ok(session.sessionId);
    const prompt = await rpc("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "在吗" }],
    });
    assert.equal(prompt.stopReason, "end_turn");
    for (let i = 0; i < 20 && !notifications.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(notifications.some((item) => item.update?.content?.text?.length > 0));
  } finally {
    child.kill();
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("recovery: restart keeps event-derived state, snapshot works", async () => {
  const root = await tempDir();  const first = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => first.server.listen(0, "127.0.0.1", resolve));
  const base1 = `http://127.0.0.1:${first.server.address().port}`;
  await fetch(`${base1}/api/characters/lin_wan/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "在吗" }),
  });
  const events1 = await (await fetch(`${base1}/api/characters/lin_wan/events`)).json();
  await first.pluginHost.close();
  await new Promise((resolve) => first.server.close(resolve));

  const second = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => second.server.listen(0, "127.0.0.1", resolve));
  const base2 = `http://127.0.0.1:${second.server.address().port}`;
  try {
    const character = await (await fetch(`${base2}/api/characters/lin_wan`)).json();
    assert.ok(character.state.eventCount >= events1.events.length);
    const recovered = await (await fetch(`${base2}/api/characters/lin_wan/recover`, { method: "POST" })).json();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.state.eventCount, events1.events.length);
    const snapshot = await (await fetch(`${base2}/api/characters/lin_wan/snapshot`, { method: "POST" })).json();
    assert.equal(snapshot.ok, true);
    const snapshots = await (await fetch(`${base2}/api/characters/lin_wan/snapshots`)).json();
    assert.equal(snapshots.snapshots.length, 1);
  } finally {
    await second.pluginHost.close();
    await new Promise((resolve) => second.server.close(resolve));
  }
});

test("dshpet: parse and import a pet pack (zip, no code)", async () => {
  const fixture = path.join(process.cwd(), "tests", "fixtures", "mini.dshpet");
  const parsed = await parseDshpetFile(fixture);
  assert.equal(parsed.manifest.id, "mini-test");
  assert.equal(parsed.animations.length, 1);
  const summary = summarizePack(parsed);
  assert.ok(summary.files >= 3);

  const root = await tempDir();
  const store = new CharacterStore(path.join(root, "characters"));
  await store.init({ seed: false });
  const result = await importDshpet({ filePath: fixture, store });
  assert.equal(result.character.name, "小测试");
  assert.equal(result.animations, 1);
  assert.equal(result.character["x-vrlink"].pet.sourceId, "mini-test");
  const loaded = await store.load(result.character.id);
  assert.equal(loaded["x-vrlink"].pet.formatVersion, 1);
  const asset = await fs.stat(path.join(store.dir(result.character.id), "pets", "thumbnail.png"));
  assert.ok(asset.size > 0);
  const source = await fs.stat(path.join(store.dir(result.character.id), "pets", "source.dshpet"));
  assert.ok(source.size > 0);
});

test("dshpet API: base64 import creates a character", async () => {
  const root = await tempDir();
  const hub = await createHub({ dataDir: root, uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(process.cwd(), "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const address = hub.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const buffer = await fs.readFile(path.join(process.cwd(), "tests", "fixtures", "mini.dshpet"));
    const imported = await (await fetch(`${base}/api/import/dshpet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: "mini.dshpet", data: buffer.toString("base64") }),
    })).json();
    assert.equal(imported.ok, true);
    assert.equal(imported.character.name, "小测试");
    assert.equal(imported.animations, 1);
    const characters = await (await fetch(`${base}/api/characters`)).json();
    assert.ok(characters.characters.some((character) => character.id === imported.character.id));
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("connections: probes bridges, chat rejects oversized text", async () => {
  const fake = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const healthUrl = `http://127.0.0.1:${fake.address().port}/health`;
  const root = await tempDir();
  const hub = await createHub({
    dataDir: root,
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir: path.join(process.cwd(), "plugins"),
    onebotHealthUrl: healthUrl,
    biliHealthUrl: healthUrl,
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const connections = await (await fetch(`${base}/api/connections`)).json();
    assert.equal(connections.onebot.online, true);
    assert.equal(connections.bili.online, true);
    assert.equal(connections.bili.mode, "draft-only");
    assert.equal(connections.home.source, "virtual");
    const tooLong = await fetch(`${base}/api/characters/lin_wan/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(4001) }),
    });
    assert.equal(tooLong.status, 413);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("plugin permissions: revoke messages.send stops plugin output, grant restores", async () => {  const root = await tempDir();
  const pluginsDir = path.join(root, "plugins", "echo");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, "plugin.json"), JSON.stringify({
    id: "echo",
    type: "code",
    apiVersion: 1,
    version: "0.1.0",
    name: "回声",
    entry: "index.mjs",
    permissions: ["events.read", "messages.send"],
    capabilities: [],
    risk: "low",
    license: "MIT",
  }), "utf8");
  await fs.writeFile(path.join(pluginsDir, "index.mjs"), `
export default function activate(api) {
  api.on("event", async (name, payload) => {
    if (payload?.type !== "message.received") return;
    api.send({ characterId: payload.characterId, text: "插件回声" });
  });
}
`, "utf8");

  const hub = await createHub({ dataDir: path.join(root, "data"), uiDir: path.join(process.cwd(), "ui"), pluginsDir: path.join(root, "plugins") });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const waitForPluginReply = async () => {
    for (let i = 0; i < 30; i += 1) {
      const data = await (await fetch(`${base}/api/characters/lin_wan/events`)).json();
      if (data.events.some((event) => event.type === "message.sent" && event.content?.text === "插件回声")) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  try {
    await fetch(`${base}/api/plugins/echo/enable`, { method: "POST" });
    await fetch(`${base}/api/characters/lin_wan/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第一次" }),
    });
    assert.equal(await waitForPluginReply(), true);

    const revoked = await (await fetch(`${base}/api/plugins/echo/permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: ["events.read"] }),
    })).json();
    assert.equal(revoked.ok, true);
    assert.deepEqual(revoked.permissions.granted, ["events.read"]);

    await fetch(`${base}/api/characters/lin_wan/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第二次" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterRevoke = await (await fetch(`${base}/api/characters/lin_wan/events`)).json();
    const pluginReplies = afterRevoke.events.filter((event) => event.content?.text === "插件回声").length;
    assert.equal(pluginReplies, 1);

    const restored = await (await fetch(`${base}/api/plugins/echo/permissions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissions: ["events.read", "messages.send"] }),
    })).json();
    assert.equal(restored.ok, true);
    await fetch(`${base}/api/characters/lin_wan/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "第三次" }),
    });
    assert.equal(await waitForPluginReply(), true);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});

test("OpenAI brain: filtered memories are injected into the system prompt", async () => {
  const calls = [];
  const brain = createOpenAIBrain({
    baseUrl: "http://fake",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "嗯。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await brain.generate({
    character: { name: "林晚", persona: { identity: "护士", baseline: "话少" } },
    event: { content: { text: "在吗" } },
    context: [],
    memories: [{ text: "她喜欢雨天", visibility: "private" }],
  });
  assert.equal(result.text, "嗯。");
  assert.match(calls[0].body.messages[0].content, /她喜欢雨天/);
});

test("local brain: llama-server compatible endpoint receives memory and persona", async () => {
  const calls = [];
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    calls.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "本地回一句。" } }] }));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${fake.address().port}`;
  try {
    const brain = createLocalBrain({ baseUrl, model: "qwen2.5-3b", apiKey: "local-key" });
    const result = await brain.generate({
      character: { name: "林晚", persona: { identity: "护士" } },
      event: { content: { text: "在吗" } },
      context: [],
      memories: [{ text: "她记得复查", visibility: "private" }],
    });
    assert.equal(result.text, "本地回一句。");
    assert.equal(calls[0].url, "/v1/chat/completions");
    assert.equal(calls[0].body.model, "qwen2.5-3b");
    assert.match(calls[0].body.messages[0].content, /她记得复查/);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});
