#!/usr/bin/env node
/**
 * M2 acceptance: two real Hub processes + a courier.
 *
 * Flow:
 *   A and B pair online (M1) -> stop B -> A sends chat offline -> courier ->
 *   restart B -> B receives, replies -> reply travels back through courier -> A.
 *
 * Run:
 *   npm run accept:m2
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CourierServer } from "../src/federation/courier.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m2-acc-"));
const tokens = {};

function spawnHub(name, token) {
  const dataDir = path.join(tempRoot, name);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VRLINK_V2_DATA: dataDir,
      VRLINK_V2_PORT: "0",
      VRLINK_FEDERATION_PORT: "0",
      VRLINK_FEDERATION_NAME: name,
      VRLINK_FEDERATION_AUTO_ACCEPT: "0",
      VRLINK_COURIER_URL: courierUrl,
      VRLINK_COURIER_TOKEN: token,
      VRLINK_COURIER_POLL_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, name, token, httpPort: null, federationPort: null, output: "", error: "" };
  const onLine = (line) => {
    state.output += `${line}\n`;
    const http = line.match(/VRlink v2 listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (http) state.httpPort = Number(http[1]);
    const fed = line.match(/VRlink federation(?: listening)? on (?:tcp:\/\/)?127\.0\.0\.1:(\d+)/);
    if (fed) state.federationPort = Number(fed[1]);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach(onLine));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.error += chunk;
  });
  return state;
}

async function waitFor(check, { timeoutMs = 10000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function api(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function apiOk(port, pathname, options = {}) {
  const result = await api(port, pathname, options);
  if (result.status >= 400 || result.body?.ok === false) {
    throw new Error(`${pathname} failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

function step(name, detail = "") {
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ""}`);
}

const courierServer = new CourierServer({ dataDir: path.join(tempRoot, "courier"), tokens });
const courierAddress = await courierServer.listen(0, "127.0.0.1");
const courierUrl = `http://127.0.0.1:${courierAddress.port}`;
let a = spawnHub("A", "token-a");
let b = spawnHub("B", "token-b");
const children = [a, b];

try {
  await waitFor(() => a.httpPort && b.httpPort && a.federationPort && b.federationPort, {
    timeoutMs: 15000,
    label: "hubs listening",
  });
  step("two hubs + courier", `courier:${courierAddress.port}`);

  const idA = (await apiOk(a.httpPort, "/api/identity")).node;
  const idB = (await apiOk(b.httpPort, "/api/identity")).node;
  tokens[idA.nodeId] = "token-a";
  tokens[idB.nodeId] = "token-b";
  step("courier tokens bound", `${idA.fingerprint} / ${idB.fingerprint}`);

  const connectPromise = api(a.httpPort, "/api/federation/connect", {
    method: "POST",
    body: JSON.stringify({ host: "127.0.0.1", port: b.federationPort, autoConfirm: true }),
  });
  const pending = await waitFor(
    async () => (await apiOk(b.httpPort, "/api/federation/pending")).pending?.[0] ?? null,
    { label: "B pending pairing" },
  );
  await apiOk(b.httpPort, "/api/federation/pending/confirm", {
    method: "POST",
    body: JSON.stringify({ id: pending.id, accept: true }),
  });
  await connectPromise;
  step("paired online", `SAS ${pending.sas}`);

  const tank = await waitFor(
    async () => {
      const result = await api(a.httpPort, `/api/federation/tank?nodeId=${encodeURIComponent(idB.nodeId)}`);
      return result.status === 200 && result.body?.tank?.chars?.length ? result.body.tank : null;
    },
    { label: "remote tank" },
  );
  const remoteChar = tank.chars.find((cert) => cert.localId === "lin_wan") ?? tank.chars[0];
  step("remote character known", remoteChar.char.slice(0, 24) + "...");

  // Stop B: simulate an offline node, then wait for A to lose the session.
  b.child.kill();
  await waitFor(() => a.httpPort && !b.child.exitCode, { timeoutMs: 2000, label: "B exit", intervalMs: 50 }).catch(() => {});
  await api(a.httpPort, "/api/federation/disconnect", {
    method: "POST",
    body: JSON.stringify({ nodeId: idB.nodeId }),
  });
  await waitFor(
    async () => (await apiOk(a.httpPort, "/api/federation/status")).federation.sessions.length === 0,
    { label: "A offline" },
  );
  step("B offline", "session closed");

  const queued = await apiOk(a.httpPort, "/api/federation/chat", {
    method: "POST",
    body: JSON.stringify({ nodeId: idB.nodeId, char: remoteChar.char, text: "M2 验收：你离线时我写的信。" }),
  });
  if (queued.response?.t !== "queued") throw new Error(`expected queued, got ${JSON.stringify(queued)}`);
  step("offline chat queued at courier", queued.response.id.slice(0, 24) + "...");

  // Restart B with the same data dir, identity, peer book and courier token.
  b = spawnHub("B", "token-b");
  children.push(b);
  await waitFor(() => b.httpPort, { timeoutMs: 15000, label: "B restarted" });
  step("B restarted", `http:${b.httpPort}`);

  const reply = await waitFor(
    async () => {
      const result = await api(a.httpPort, `/api/federation/tank?nodeId=${encodeURIComponent(idB.nodeId)}`);
      const events = result.body?.tank?.events?.[remoteChar.char] ?? [];
      return events.find((event) => event.type === "message.sent" && event.origin === idB.nodeId) ?? null;
    },
    { timeoutMs: 15000, label: "offline reply" },
  );
  if (!reply.content?.text) throw new Error("offline reply has no text");
  step("offline reply synced", reply.content.text.slice(0, 40));

  console.log("");
  console.log("M2 ACCEPTANCE: PASS (7 steps)");
} catch (error) {
  console.error("");
  console.error("M2 ACCEPTANCE: FAIL");
  console.error(error?.stack ?? error);
  for (const state of children) {
    console.error(`--- ${state.name} stdout ---\n${state.output}`);
    console.error(`--- ${state.name} stderr ---\n${state.error}`);
  }
  process.exitCode = 1;
} finally {
  for (const state of children) {
    try {
      state.child.kill();
    } catch {
      /* ignore */
    }
  }
  await courierServer.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
}
