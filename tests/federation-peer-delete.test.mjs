import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-peer-del-"));
}

async function makeHub(root, name) {
  const pluginsDir = path.join(root, `plugins-${name}`);
  await fs.mkdir(pluginsDir, { recursive: true });
  return createHub({
    dataDir: path.join(root, name),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: name,
    federationAutoAccept: true,
  });
}

async function listen(hub) {
  const port = await new Promise((resolve) =>
    hub.server.listen(0, "127.0.0.1", () => resolve(hub.server.address().port)),
  );
  return `http://127.0.0.1:${port}`;
}

async function closeHub(hub) {
  await hub.federation.close();
  await hub.pluginHost.close();
  if (hub.server.listening) await new Promise((resolve) => hub.server.close(resolve));
}

async function waitFor(check, { timeoutMs = 8000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, data: await response.json() };
}

async function get(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, data: await response.json() };
}

async function del(base, pathname) {
  const response = await fetch(`${base}${pathname}`, { method: "DELETE" });
  return { status: response.status, data: await response.json() };
}

async function pair(a, b) {
  await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
  const nodeA = a.identity.publicIdentity().nodeId;
  const nodeB = b.identity.publicIdentity().nodeId;
  await waitFor(() => a.federation.sessions.size === 1 && b.federation.sessions.size === 1, {
    label: "both sessions",
  });
  return { nodeA, nodeB };
}

test("删除好友：联系人、聊天记录、当前会话一起清掉", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "del-a");
  const b = await makeHub(root, "del-b");
  try {
    const baseA = await listen(a);
    await listen(b);
    const { nodeB } = await pair(a, b);
    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "你好，删除前的消息" });
    const threadsBefore = await get(baseA, "/api/human/threads");
    assert.equal((threadsBefore.data.threads ?? []).length, 1);

    const removed = await del(baseA, `/api/federation/peers/${encodeURIComponent(nodeB)}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.data.ok, true);
    assert.equal((removed.data.human ?? {}).ok, true);

    const peersAfter = await get(baseA, "/api/federation/peers");
    assert.equal((peersAfter.data.peers ?? []).length, 0, "联系人应已删除");
    const threadsAfter = await get(baseA, "/api/human/threads");
    assert.equal((threadsAfter.data.threads ?? []).length, 0, "聊天记录应已删除");
    await waitFor(() => a.federation.sessions.size === 0, { label: "session dropped" });
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("删除好友：不存在的节点返回 404，重复删除也安全", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "del-c");
  try {
    const baseA = await listen(a);
    const missing = await del(baseA, "/api/federation/peers/vrl%3Anode%3Anope");
    assert.equal(missing.status, 404);
    assert.equal(missing.data.ok, false);
  } finally {
    await closeHub(a);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("删除好友不是拉黑：对方重新发起连接仍能再次成为好友", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "del-d");
  const b = await makeHub(root, "del-e");
  try {
    const baseA = await listen(a);
    await listen(b);
    const { nodeB } = await pair(a, b);
    await del(baseA, `/api/federation/peers/${encodeURIComponent(nodeB)}`);
    await waitFor(() => a.federation.sessions.size === 0 && b.federation.sessions.size === 0, {
      label: "both sessions closed",
    });
    // B 主动重连（A 的测试 Hub 开了 autoConfirm，等价于对方重新申请并被接受）
    await b.federation.connect("127.0.0.1", a.federation.listenAddress.port, { autoConfirm: true });
    const peers = await waitFor(async () => {
      const row = await get(baseA, "/api/federation/peers");
      const list = row.data.peers ?? [];
      return list.some((peer) => peer.nodeId === nodeB) ? list : null;
    }, { label: "peer re-added after reconnect" });
    assert.equal(peers.find((peer) => peer.nodeId === nodeB)?.blocked, false, "重新加回后不应是拉黑状态");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
