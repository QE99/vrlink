import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";
import { verifyCertifiedEvent } from "../src/federation/identity.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m1-"));
}

async function makeHub(root, name, options = {}) {
  const pluginsDir = path.join(root, `plugins-${name}`);
  await fs.mkdir(pluginsDir, { recursive: true });
  return createHub({
    dataDir: path.join(root, name),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: name,
    federationAutoAccept: true,
    ...options,
  });
}

async function closeHub(hub) {
  await hub.federation.close();
  await hub.pluginHost.close();
  if (hub.server.listening) {
    await new Promise((resolve) => hub.server.close(resolve));
  }
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("federation M1: two nodes pair, exchange profiles, and see each other's tanks", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const nodeB = b.identity.publicIdentity().nodeId;
    const nodeA = a.identity.publicIdentity().nodeId;
    const session = await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });

    assert.equal(session.nodeId, nodeB);
    assert.match(session.sas, /^\d{6}$/);
    await waitFor(
      () => a.federation.sessions.size === 1 && b.federation.sessions.size === 1,
      { label: "both sessions" },
    );
    assert.equal(a.federation.status().sessions.length, 1);
    assert.equal(b.federation.status().sessions.length, 1);

    const tank = await waitFor(() => a.federation.remoteTank(nodeB), { label: "remote tank" });
    assert.ok(tank.chars.length >= 1);
    const remoteChar = tank.chars[0];
    assert.match(remoteChar.char, /^vrl:char:/);
    assert.equal(remoteChar.localId, "lin_wan");
    assert.equal(remoteChar.node, nodeB);

    const peerA = await a.peerStore.get(nodeB);
    const peerB = await b.peerStore.get(nodeA);
    assert.ok(peerA?.pairing?.sigLocal);
    assert.ok(peerA?.pairing?.sigPeer);
    assert.ok(peerB?.pairing?.sigLocal);
    assert.ok(peerB?.pairing?.sigPeer);
    assert.equal(peerA.grants.chat, true);
    assert.equal(peerA.grants.tankView, true);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M1: chat reaches the remote character and reply syncs back verified", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a", { federationName: "A" });
  const b = await makeHub(root, "b", { federationName: "B" });
  try {
    const nodeB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    const tank = await waitFor(() => a.federation.remoteTank(nodeB), { label: "remote tank" });
    const remoteChar = tank.chars.find((cert) => cert.localId === "lin_wan");
    assert.ok(remoteChar);

    const ack = await a.federation.chat(nodeB, remoteChar.char, "在吗？我是 A 节点的朋友。");
    assert.equal(ack.t, "ack");
    assert.equal(ack.ok, true);

    const event = await waitFor(
      () => {
        const current = a.federation.remoteTank(nodeB);
        return (current?.events?.[remoteChar.char] ?? []).find((item) => item.type === "message.sent");
      },
      { label: "remote reply" },
    );
    assert.equal(event.char, remoteChar.char);
    assert.equal(event.origin, nodeB);
    assert.ok(event.content.text.length > 0);

    const verified = verifyCertifiedEvent(event, remoteChar, b.identity.publicIdentity().cert);
    assert.equal(verified.ok, true);

    const received = (a.federation.remoteTank(nodeB).events[remoteChar.char] ?? []).find(
      (item) => item.type === "message.received",
    );
    assert.ok(received);
    assert.match(received.content.text, /A 节点的朋友/);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M1: reconnect uses the stored peer record; revoke blocks it", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const nodeB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => a.federation.sessions.size === 1, { label: "first session" });
    assert.equal((await a.peerStore.list()).length, 1);

    a.federation.disconnect(nodeB);
    await waitFor(() => a.federation.sessions.size === 0, { label: "disconnect" });
    const second = await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: false });
    assert.equal(second.nodeId, nodeB);
    assert.equal((await a.peerStore.list()).length, 1);

    await a.peerStore.revoke(nodeB);
    a.federation.disconnect(nodeB);
    await waitFor(() => a.federation.sessions.size === 0, { label: "revoked disconnect" });
    // 撤销后的安全属性：连接一律不能成功（要么 PEER_BLOCKED，要么网络层失败），也不能留会话
    let resolved = 0;
    let rejected = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
        resolved += 1;
        a.federation.disconnect(nodeB);
      } catch {
        rejected += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    assert.equal((await a.peerStore.get(nodeB))?.blocked, true);
    assert.equal(a.federation.sessions.size, 0, "撤销后不应留下会话");
    assert.equal(resolved, 0, "撤销后连接不能成功");
    assert.ok(rejected >= 1, "至少要有一次连接被拒绝");  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M1: first contact can be held for SAS confirmation", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a", { federationAutoAccept: true });
  const b = await makeHub(root, "b", { federationAutoAccept: false });
  try {
    const pendingPromise = new Promise((resolve) => b.federation.once("pair-request", resolve));
    const connecting = a.federation.connect("127.0.0.1", b.federation.listenAddress.port, {
      autoConfirm: true,
    });
    const pending = await pendingPromise;
    assert.match(pending.sas, /^\d{6}$/);
    assert.equal(pending.peer.nodeId, a.identity.publicIdentity().nodeId);
    assert.ok(b.federation.listPendingPairs().length >= 1);
    assert.equal(b.federation.confirmPairing(pending.id, true), true);
    const session = await connecting;
    assert.equal(session.nodeId, b.identity.publicIdentity().nodeId);
    assert.equal(b.federation.listPendingPairs().length, 0);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M1: first contact is rejected when the local side does not confirm", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a", { federationAutoAccept: false });
  const b = await makeHub(root, "b", { federationAutoAccept: true });
  try {
    const pendingPromise = new Promise((resolve) => a.federation.once("pair-request", resolve));
    const connecting = a.federation.connect("127.0.0.1", b.federation.listenAddress.port, {
      autoConfirm: false,
    });
    const pending = await pendingPromise;
    assert.equal(a.federation.confirmPairing(pending.id, false), true);
    await assert.rejects(connecting, (error) => error.code === "PAIR_REJECTED");
    assert.equal((await a.peerStore.list()).length, 0);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
