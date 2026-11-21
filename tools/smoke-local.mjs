#!/usr/bin/env node
// Smoke-test a real local llama-server through VRlink's local brain.
// Start llama-server first (see CONNECTIONS.md), then:
//   $env:VRLINK_LOCAL_BASE_URL="http://127.0.0.1:12345"
//   $env:VRLINK_LOCAL_API_KEY="..."   # only if llama-server uses --api-key
//   npm run smoke:local
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHub } from "../src/server.mjs";

if (!process.env.VRLINK_LOCAL_BASE_URL) {
  console.error("set VRLINK_LOCAL_BASE_URL first (e.g. http://127.0.0.1:12345)");
  process.exit(2);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-v2-local-"));
const hub = await createHub({
  dataDir: root,
  uiDir: path.join(process.cwd(), "ui"),
  pluginsDir: path.join(process.cwd(), "plugins"),
  rateLimit: 1000,
});
await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${hub.server.address().port}`;
try {
  const created = await fetch(`${base}/api/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "local_fish",
      name: "本地鱼",
      persona: { identity: "本地模型测试角色", baseline: "简短回话" },
      brain: { engine: "local", model: process.env.VRLINK_LOCAL_MODEL || "", temperature: 0.7 },
    }),
  });
  if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const started = Date.now();
  const response = await fetch(`${base}/api/characters/local_fish/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "用一句话介绍你自己。" }),
  });
  const elapsed = Date.now() - started;
  const data = await response.json();
  console.log(JSON.stringify({ ok: response.ok, ms: elapsed, reply: data.reply, error: data.error }, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  await hub.pluginHost.close();
  await new Promise((resolve) => hub.server.close(resolve));
}
