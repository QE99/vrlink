#!/usr/bin/env node
/**
 * Self-hosted courier process.
 *
 * Usage:
 *   npm run courier
 *   npm run courier -- --data D:\vrlink-courier --port 5280 --host 127.0.0.1
 *
 * Tokens file (JSON, nodeId -> token):
 *   data/courier/tokens.json
 *
 * The courier is reloaded every 2 seconds, so you can add a node after it
 * starts. It only stores ciphertext; tokens are self-hosted credentials.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { CourierServer } from "../src/federation/courier.mjs";

const argv = process.argv.slice(2);
function arg(name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

const dataDir = path.resolve(arg("data", process.env.VRLINK_COURIER_DATA ?? path.join(process.cwd(), "data", "courier")));
const tokensFile = path.resolve(arg("tokens", process.env.VRLINK_COURIER_TOKENS ?? path.join(dataDir, "tokens.json")));
const port = Number(arg("port", process.env.VRLINK_COURIER_PORT ?? 5280));
const host = arg("host", process.env.VRLINK_COURIER_HOST ?? "127.0.0.1");

await fs.mkdir(dataDir, { recursive: true });

async function readTokens() {
  try {
    const value = JSON.parse(await fs.readFile(tokensFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    console.warn(`[courier] tokens file ignored: ${error?.message ?? error}`);
    return {};
  }
}

const tokens = await readTokens();
const server = new CourierServer({ dataDir, tokens });
const address = await server.listen(port, host);
console.log(`VRlink courier on http://${address.host}:${address.port}`);
console.log(`  data:   ${dataDir}`);
console.log(`  tokens: ${tokensFile} (${Object.keys(tokens).length} nodes)`);

const timer = setInterval(async () => {
  const next = await readTokens();
  server.tokens = next;
}, 2000);
timer.unref?.();

process.on("SIGINT", async () => {
  clearInterval(timer);
  await server.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  clearInterval(timer);
  await server.close();
  process.exit(0);
});
