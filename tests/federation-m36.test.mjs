import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";
import { GroupStore } from "../src/federation/groups.mjs";
import { IdentityStore } from "../src/federation/identity.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m36-"));
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

async function waitFor(check, { timeoutMs = 5000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function groups(hub) {
  return (await (await fetch(`http://127.0.0.1:${hub.server.address().port}/api/federation/groups`)).json()).groups ?? [];
}

test("federation M3.6: group store persists local messages", async () => {
  const root = await tempDir();
  try {
    const identity = await new IdentityStore({ dataDir: path.join(root, "node"), charactersDir: path.join(root, "chars") }).init();
    const store = await new GroupStore({ dir: path.join(root, "federation"), identity, name: "A" }).init();
    const group = await store.create({ name: "夜航小队", members: [{ nodeId: "vrl:node:b", name: "B" }] });
    assert.equal(group.members.length, 2);
    await store.append(group.id, { from: "vrl:node:b", fromName: "B", text: "在吗" });
    const reopened = await new GroupStore({ dir: path.join(root, "federation"), identity, name: "A" }).init();
    const restored = reopened.get(group.id);
    assert.equal(restored.messages.length, 1);
    assert.equal(restored.messages[0].text, "在吗");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.6: a group message fans out to members", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const idB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => a.federation.status().sessions.length === 1, { label: "A session" });

    const created = await (
      await fetch(`http://127.0.0.1:${a.server.address().port}/api/federation/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "夜航小队", members: [idB] }),
      })
    ).json();
    const groupId = created.group.id;
    const sent = await (
      await fetch(`http://127.0.0.1:${a.server.address().port}/api/federation/groups/${encodeURIComponent(groupId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A 在群里说：今晚出海。" }),
      })
    ).json();
    assert.equal(sent.ok, true);
    assert.equal(sent.deliveries[0].ok, true);

    const onB = await waitFor(async () => {
      const group = (await groups(b)).find((item) => item.id === groupId);
      return group?.messages?.some((message) => message.text === "A 在群里说：今晚出海。") ? group : null;
    }, { label: "B group message" });
    assert.equal(onB.members.length, 2);

    const reply = await (
      await fetch(`http://127.0.0.1:${b.server.address().port}/api/federation/groups/${encodeURIComponent(groupId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "B 在群里回：收到。" }),
      })
    ).json();
    assert.equal(reply.ok, true);
    const onA = await waitFor(async () => {
      const group = (await groups(a)).find((item) => item.id === groupId);
      return group?.messages?.some((message) => message.text === "B 在群里回：收到。") ? group : null;
    }, { label: "A group reply" });
    assert.ok(onA.messages.length >= 2);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.6: group membership sync, removal and dissolve", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const idB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => a.federation.status().sessions.length === 1, { label: "A session" });
    const created = await (
      await fetch(`http://127.0.0.1:${a.server.address().port}/api/federation/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "同步测试群", members: [idB] }),
      })
    ).json();
    const groupId = created.group.id;
    await waitFor(async () => (await groups(b)).some((group) => group.id === groupId), { label: "B receives group snapshot" });

    const kicked = await (
      await fetch(`http://127.0.0.1:${a.server.address().port}/api/federation/groups/${encodeURIComponent(groupId)}/members/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: idB }),
      })
    ).json();
    // 规则（2026-11-18）：成员少于 3 人自动解散；2 人群踢掉一个后只剩群主 → 直接解散
    assert.equal(kicked.dissolved, true);
    await waitFor(async () => !(await groups(b)).some((group) => group.id === groupId), { label: "B clears group after kick" });
    await waitFor(async () => !(await groups(a)).some((group) => group.id === groupId), { label: "A clears group after kick" });
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.6: guest links are read-only and revocable", async () => {
  const root = await tempDir();
  const hub = await makeHub(root, "guest");
  try {
    const character = (await hub.store.list())[0];
    assert.ok(character);
    const created = await (
      await fetch(`http://127.0.0.1:${hub.server.address().port}/api/guest-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: character.id, ttlHours: 1, label: "测试访客" }),
      })
    ).json();
    assert.equal(created.ok, true);
    assert.match(created.url, /\/guest\//);
    const token = created.url.split("/").pop();

    const view = await (await fetch(`http://127.0.0.1:${hub.server.address().port}/api/guest/${encodeURIComponent(token)}`)).json();
    assert.equal(view.ok, true);
    assert.equal(view.guest.name, character.name);
    assert.ok(!("nodeId" in view.guest));

    const page = await fetch(`http://127.0.0.1:${hub.server.address().port}/guest/${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /只读访客/);

    const list = await (await fetch(`http://127.0.0.1:${hub.server.address().port}/api/guest-tokens`)).json();
    assert.equal(list.tokens.length, 1);
    assert.equal(list.tokens[0].tokenHash, undefined);

    await fetch(`http://127.0.0.1:${hub.server.address().port}/api/guest-tokens/${encodeURIComponent(list.tokens[0].id)}/revoke`, { method: "POST" });
    const revoked = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/guest/${encodeURIComponent(token)}`);
    assert.equal(revoked.status, 404);
  } finally {
    await closeHub(hub);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
