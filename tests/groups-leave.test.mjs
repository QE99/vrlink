import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

// 群规则（2026-11-18）：
// 1) 普通成员可以自己退群（群主不能退，只能解散）
// 2) 群成员少于 3 人时自动解散

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-gleave-"));
}

async function makeHub(root, name) {
  const pluginsDir = path.join(root, `plugins-${name}`);
  await fs.mkdir(pluginsDir, { recursive: true });
  const hub = await createHub({
    dataDir: path.join(root, name),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: name,
    federationAutoAccept: true,
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  return hub;
}

async function closeHub(hub) {
  await hub.federation.close();
  await hub.pluginHost.close();
  if (hub.server.listening) {
    await new Promise((resolve) => hub.server.close(resolve));
  }
}

async function waitFor(check, { timeoutMs = 6000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function url(hub, suffix) {
  return `http://127.0.0.1:${hub.server.address().port}${suffix}`;
}

async function post(hub, suffix, body = {}) {
  const res = await fetch(url(hub, suffix), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function listGroups(hub) {
  return (await (await fetch(url(hub, "/api/federation/groups"))).json()).groups ?? [];
}

test("退群：普通成员可退，群主不能退，退到少于 3 人自动解散", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  const c = await makeHub(root, "c");
  const d = await makeHub(root, "d");
  try {
    const idA = a.identity.publicIdentity().nodeId;
    const idB = b.identity.publicIdentity().nodeId;
    const idC = c.identity.publicIdentity().nodeId;
    const idD = d.identity.publicIdentity().nodeId;
    for (const peer of [b, c, d]) {
      await a.federation.connect("127.0.0.1", peer.federation.listenAddress.port, { autoConfirm: true });
    }
    await waitFor(() => a.federation.status().sessions.length === 3, { label: "A sessions" });
    // 群消息/群变更按“成员之间已有的 1:1 连接”分发；B 退群时要能直接通知 C。
    await b.federation.connect("127.0.0.1", c.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => b.federation.status().sessions.length >= 2, { label: "B-C session" });

    const created = await post(a, "/api/federation/groups", { name: "三端演示", members: [idB, idC] });
    assert.equal(created.body.ok, true);
    const groupId = created.body.group.id;
    assert.equal(created.body.group.members.length, 3);
    await waitFor(async () => (await listGroups(b)).some((group) => group.id === groupId), { label: "B receives group" });
    await waitFor(async () => (await listGroups(c)).some((group) => group.id === groupId), { label: "C receives group" });

    // 群主不能退
    const ownerLeave = await post(a, `/api/federation/groups/${encodeURIComponent(groupId)}/leave`);
    assert.equal(ownerLeave.status, 403);

    // 普通成员退群 → 剩 2 人 → 自动解散，三端都清掉
    const left = await post(b, `/api/federation/groups/${encodeURIComponent(groupId)}/leave`);
    assert.equal(left.body.ok, true);
    assert.equal(left.body.dissolved, true);
    await waitFor(async () => !(await listGroups(b)).some((group) => group.id === groupId), { label: "B clears group" });
    await waitFor(async () => !(await listGroups(a)).some((group) => group.id === groupId), { label: "A clears group" });
    await waitFor(async () => !(await listGroups(c)).some((group) => group.id === groupId), { label: "C clears group" });

    // 4 人群里退一个 → 剩 3 人，群保留（边界）
    const four = await post(a, "/api/federation/groups", { name: "四人团", members: [idB, idC, idD] });
    assert.equal(four.body.ok, true);
    const keptId = four.body.group.id;
    assert.equal(four.body.group.members.length, 4);
    await waitFor(async () => (await listGroups(b)).some((group) => group.id === keptId), { label: "B receives 4-person group" });

    const leaveOne = await post(b, `/api/federation/groups/${encodeURIComponent(keptId)}/leave`);
    assert.equal(leaveOne.body.ok, true);
    assert.equal(leaveOne.body.dissolved, false);
    const keptOnA = await waitFor(async () => {
      const group = (await listGroups(a)).find((item) => item.id === keptId);
      return group && group.members.length === 3 ? group : null;
    }, { label: "A keeps 3-person group" });
    assert.ok(!keptOnA.members.some((member) => member.nodeId === idB));
    assert.ok(keptOnA.members.some((member) => member.nodeId === idA));
  } finally {
    await closeHub(a);
    await closeHub(b);
    await closeHub(c);
    await closeHub(d);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

