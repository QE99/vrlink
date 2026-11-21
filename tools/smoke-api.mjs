#!/usr/bin/env node
// Smoke-test the cloud API brain with the "大肥鱼·夜" card.
//   $env:VRLINK_BRAIN_BASE_URL="https://api.deepseek.com"
//   $env:VRLINK_BRAIN_API_KEY="..."
//   $env:VRLINK_BRAIN_MODEL="deepseek-flash"
//   npm run smoke:api
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHub } from "../src/server.mjs";

if (!process.env.VRLINK_BRAIN_API_KEY) {
  console.error("set VRLINK_BRAIN_API_KEY first (do not commit it)");
  process.exit(2);
}

const cardPath = path.join(process.cwd(), "data", "cards", "dafeiyu-night.card.json");
const card = JSON.parse(await fs.readFile(cardPath, "utf8"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-v2-api-"));
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
    body: JSON.stringify(card),
  });
  if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const started = Date.now();
  const response = await fetch(`${base}/api/characters/${card.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "在吗？今晚陪我待会儿。" }),
  });
  const elapsed = Date.now() - started;
  const data = await response.json();
  console.log(JSON.stringify({ ok: response.ok, ms: elapsed, reply: data.reply, error: data.error }, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  await hub.pluginHost.close();
  await new Promise((resolve) => hub.server.close(resolve));
}
