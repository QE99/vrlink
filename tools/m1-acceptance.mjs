#!/usr/bin/env node
/**
 * M1 acceptance: two real Hub processes, pair over TCP, sync, chat, revoke.
 *
 * Run:
 *   npm run accept:m1
 *
 * This starts two `node src/server.mjs` processes on ephemeral ports, uses the
 * local HTTP APIs, and prints PASS/FAIL. It does not touch the real data dir.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m1-acc-"));

function spawnHub(name) {
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, name, httpPort: null, federationPort: null, output: "", error: "" };
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

const a = spawnHub("A");
const b = spawnHub("B");
const children = [a, b];

try {
  await waitFor(() => a.httpPort && a.federationPort && b.httpPort && b.federationPort, {
    timeoutMs: 15000,
    label: "both hubs listening",
  });
  step("two hubs listening", `A http:${a.httpPort} fed:${a.federationPort} / B http:${b.httpPort} fed:${b.federationPort}`);

  const idA = (await apiOk(a.httpPort, "/api/identity")).node;
  const idB = (await apiOk(b.httpPort, "/api/identity")).node;
  if (idA.nodeId === idB.nodeId) throw new Error("nodes have the same identity");
  step("distinct node identities", `${idA.fingerprint} / ${idB.fingerprint}`);

  const connectPromise = api(a.httpPort, "/api/federation/connect", {
    method: "POST",
    body: JSON.stringify({ host: "127.0.0.1", port: b.federationPort, autoConfirm: true }),
  });
  const pending = await waitFor(
    async () => {
      const result = await apiOk(b.httpPort, "/api/federation/pending");
      return result.pending?.[0] ?? null;
    },
    { label: "B pending pairing" },
  );
  if (!/^\d{6}$/.test(pending.sas)) throw new Error(`bad SAS: ${pending.sas}`);
  step("SAS pending", `B sees ${pending.sas} from ${pending.peer.name}`);
  await apiOk(b.httpPort, "/api/federation/pending/confirm", {
    method: "POST",
    body: JSON.stringify({ id: pending.id, accept: true }),
  });
  const connectResult = await connectPromise;
  if (connectResult.status >= 400 || connectResult.body?.ok === false) {
    throw new Error(`connect failed: ${connectResult.status} ${JSON.stringify(connectResult.body)}`);
  }
  step("paired", `A connected to ${connectResult.body.peer.nodeId.slice(0, 20)}...`);

  const status = await apiOk(a.httpPort, "/api/federation/status");
  if (!status.federation.sessions.some((item) => item.nodeId === idB.nodeId)) {
    throw new Error("A has no session with B");
  }
  step("session established", `sessions=${status.federation.sessions.length}`);

  const tank = await waitFor(
    async () => {
      const result = await api(a.httpPort, `/api/federation/tank?nodeId=${encodeURIComponent(idB.nodeId)}`);
      return result.status === 200 && result.body?.tank?.chars?.length ? result.body.tank : null;
    },
    { label: "remote tank" },
  );
  const remoteChar = tank.chars.find((cert) => cert.localId === "lin_wan") ?? tank.chars[0];
  step("remote tank visible", `${remoteChar.name} ${remoteChar.char.slice(0, 24)}...`);

  const chat = await apiOk(a.httpPort, "/api/federation/chat", {
    method: "POST",
    body: JSON.stringify({ nodeId: idB.nodeId, char: remoteChar.char, text: "M1 验收：在吗？" }),
  });
  if (chat.response?.t !== "ack" || chat.response.ok !== true) {
    throw new Error(`chat failed: ${JSON.stringify(chat)}`);
  }
  step("chat ack", "remote character accepted the message");

  const reply = await waitFor(
    async () => {
      const result = await api(a.httpPort, `/api/federation/tank?nodeId=${encodeURIComponent(idB.nodeId)}`);
      const events = result.body?.tank?.events?.[remoteChar.char] ?? [];
      return events.find((event) => event.type === "message.sent") ?? null;
    },
    { label: "remote reply" },
  );
  if (!reply.content?.text) throw new Error("reply has no text");
  step("reply synced", reply.content.text.slice(0, 40));

  await apiOk(a.httpPort, "/api/federation/revoke", {
    method: "POST",
    body: JSON.stringify({ nodeId: idB.nodeId }),
  });
  step("revoked", idB.nodeId.slice(0, 20) + "...");

  const rejected = await api(a.httpPort, "/api/federation/connect", {
    method: "POST",
    body: JSON.stringify({ host: "127.0.0.1", port: b.federationPort, autoConfirm: true }),
  });
  if (rejected.status < 400 || rejected.body?.code !== "PEER_BLOCKED") {
    throw new Error(`revoked peer was not rejected: ${rejected.status} ${JSON.stringify(rejected.body)}`);
  }
  step("revoked peer rejected", rejected.body.code);

  console.log("");
  console.log("M1 ACCEPTANCE: PASS (8 steps)");
} catch (error) {
  console.error("");
  console.error(`M1 ACCEPTANCE: FAIL`);
  console.error(error?.stack ?? error);
  console.error("--- A stdout ---\n" + a.output);
  console.error("--- A stderr ---\n" + a.error);
  console.error("--- B stdout ---\n" + b.output);
  console.error("--- B stderr ---\n" + b.error);
  process.exitCode = 1;
} finally {
  for (const state of children) {
    try {
      state.child.kill();
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
}
