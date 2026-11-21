#!/usr/bin/env node
// End-to-end acceptance for the v2 walking skeleton.
// Starts a fresh Hub in a temp dir, exercises the real HTTP/WS paths, then restarts it.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

const steps = [];
function ok(name) {
  steps.push(name);
  console.log(`PASS  ${name}`);
}

async function startHub(dataDir, pluginsDir) {
  const hub = await createHub({
    dataDir,
    pluginsDir,
    uiDir: path.join(process.cwd(), "ui"),
    rateLimit: 10000,
    apiConcurrency: 2,
    homeDemo: true,
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  return { hub, base: `http://127.0.0.1:${hub.server.address().port}` };
}

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { status: response.status, data };
}

async function waitFor(fn, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-v2-e2e-"));
const pluginsDir = path.join(root, "plugins");
const echoDir = path.join(pluginsDir, "echo");
await fs.mkdir(echoDir, { recursive: true });
await fs.writeFile(path.join(echoDir, "plugin.json"), JSON.stringify({
  id: "echo",
  type: "code",
  apiVersion: 1,
  version: "0.1.0",
  name: "验收回声",
  entry: "index.mjs",
  permissions: ["events.read", "messages.send"],
  capabilities: [],
  risk: "low",
  license: "MIT",
}), "utf8");
await fs.writeFile(path.join(echoDir, "index.mjs"), `
export default function activate(api) {
  api.on("event", async (name, payload) => {
    if (payload?.type !== "message.received") return;
    api.send({ characterId: payload.characterId, text: "插件回声" });
  });
}
`, "utf8");

let current = await startHub(path.join(root, "data"), pluginsDir);
try {
  const health = await json(`${current.base}/api/health`);
  assert.equal(health.data.ok, true);
  ok("health");

  const characters = await json(`${current.base}/api/characters`);
  const id = characters.data.characters[0].id;
  assert.equal(id, "lin_wan");
  ok("seed character");

  const chat = await json(`${current.base}/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "今天好累" }),
  });
  assert.equal(chat.data.ok, true);
  assert.ok(chat.data.reply.length > 0);
  ok("desktop chat");

  const qq = await json(`${current.base}/api/characters/${id}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "qq", thread: "private:owner", text: "QQ 上问在吗", visibility: "private" }),
  });
  assert.equal(qq.data.ok, true);
  assert.ok(qq.data.produced.some((event) => event.type === "message.sent" && event.source.body === "qq"));
  ok("QQ body -> life stream");

  const draft = await json(`${current.base}/api/characters/${id}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "这条鱼好可爱", body: "bili", thread: "bili:comment", visibility: "public" }),
  });
  assert.equal(draft.data.ok, true);
  assert.ok(draft.data.draft.length > 0);
  const eventsAfterDraft = await json(`${current.base}/api/characters/${id}/events`);
  assert.ok(eventsAfterDraft.data.events.some((event) => event.type === "message.draft" && event.source.body === "bili"));
  assert.equal(eventsAfterDraft.data.events.some((event) => event.type === "message.sent" && event.source.body === "bili"), false);
  ok("Bilibili draft-only");

  const low = await json(`${current.base}/api/devices/living_room_curtain/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: id, command: "close" }),
  });
  assert.equal(low.data.ok, true);
  const high = await json(`${current.base}/api/devices/front_door_lock/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: id, command: "unlock" }),
  });
  assert.equal(high.status, 403);
  assert.equal(high.data.code, "CONSENT_REQUIRED");
  const approve = await json(`${current.base}/api/consent/requests/${high.data.requestId}/approve`, { method: "POST" });
  assert.equal(approve.data.ok, true);
  const retry = await json(`${current.base}/api/devices/front_door_lock/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: id, command: "unlock", approvalToken: approve.data.grant.id }),
  });
  assert.equal(retry.data.ok, true);
  ok("device low risk + high risk consent");

  const enabled = await json(`${current.base}/api/plugins/echo/enable`, { method: "POST" });
  assert.equal(enabled.data.ok, true);
  await json(`${current.base}/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "插件第一次" }),
  });
  assert.equal(await waitFor(async () => {
    const data = await json(`${current.base}/api/characters/${id}/events`);
    return data.data.events.some((event) => event.content?.text === "插件回声");
  }), true);
  const revoked = await json(`${current.base}/api/plugins/echo/permissions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissions: ["events.read"] }),
  });
  assert.deepEqual(revoked.data.permissions.granted, ["events.read"]);
  ok("plugin child process + permission revoke");

  const a2a = await json(`${current.base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "A2A 在吗" }] } },
    }),
  });
  assert.equal(a2a.data.result.status.state, "completed");
  assert.ok(a2a.data.result.artifacts[0].parts[0].text.length > 0);
  ok("A2A JSON-RPC");

  const ws = new WebSocket(`ws://127.0.0.1:${current.hub.server.address().port}/ws/characters/${id}`);
  const wsMessages = [];
  ws.addEventListener("message", (event) => wsMessages.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  assert.equal(await waitFor(() => wsMessages.some((item) => item.type === "snapshot")), true);
  await json(`${current.base}/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "WebSocket 在吗" }),
  });
  assert.equal(await waitFor(() => wsMessages.some((item) => item.event?.type === "message.sent")), true);
  ws.close();
  ok("WebSocket life stream");

  const safe = await json(`${current.base}/api/safe-mode`, { method: "POST" });
  assert.equal(safe.data.safeMode, true);
  const blocked = await json(`${current.base}/api/devices/living_room_curtain/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: id, command: "close" }),
  });
  assert.equal(blocked.status, 503);
  await json(`${current.base}/api/safe-mode/off`, { method: "POST" });
  ok("safe mode");

  const before = await json(`${current.base}/api/characters/${id}/events`);
  await current.hub.pluginHost.close();
  await new Promise((resolve) => current.hub.server.close(resolve));
  current = await startHub(path.join(root, "data"), pluginsDir);
  const after = await json(`${current.base}/api/characters/${id}`);
  assert.ok(after.data.state.eventCount >= before.data.events.length);
  ok("restart / state recovery");

  console.log(`\nE2E PASS: ${steps.length} steps`);
} catch (error) {
  console.error(`\nE2E FAIL: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await current.hub.pluginHost.close();
    await new Promise((resolve) => current.hub.server.close(resolve));
  } catch {
    /* ignore */
  }
}
