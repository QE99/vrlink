import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";
import { IdentityStore } from "../src/federation/identity.mjs";
import { PostcardStore } from "../src/federation/postcards.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m3-"));
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

test("federation M3: remote tank events persist across a restart", async () => {
  const root = await tempDir();
  let a = await makeHub(root, "a", { federationName: "A" });
  let b = await makeHub(root, "b", { federationName: "B" });
  try {
    const nodeB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    const tank = await waitFor(() => a.federation.remoteTank(nodeB), { label: "remote tank" });
    const remoteChar = tank.chars.find((cert) => cert.localId === "lin_wan") ?? tank.chars[0];
    assert.ok(remoteChar);
    await a.federation.chat(nodeB, remoteChar.char, "M3 持久化：记住这句话。");
    await waitFor(
      () => (a.federation.remoteTank(nodeB)?.events?.[remoteChar.char] ?? []).find((event) => event.type === "message.sent"),
      { label: "reply" },
    );

    await closeHub(a);
    a = null;
    await closeHub(b);
    b = null;

    const reopened = await makeHub(root, "a", { federationName: "A" });
    try {
      const restored = await waitFor(
        () => {
          const current = reopened.federation.remoteTank(nodeB);
          return current?.events?.[remoteChar.char]?.length ? current : null;
        },
        { label: "restored remote events" },
      );
      const events = restored.events[remoteChar.char];
      assert.ok(events.some((event) => event.type === "message.sent"));
      assert.ok(events.some((event) => event.type === "message.received"));
      assert.equal(restored.peer.nodeId, nodeB);
    } finally {
      await closeHub(reopened);
    }
  } finally {
    if (a) await closeHub(a).catch(() => {});
    if (b) await closeHub(b).catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3: postcards are signed and listed", async () => {
  const root = await tempDir();
  const identity = await new IdentityStore({
    dataDir: path.join(root, "node"),
    charactersDir: path.join(root, "characters"),
  }).init();
  const store = await new PostcardStore({
    dir: path.join(root, "postcards"),
    identity,
    name: "A 的缸",
  }).init();
  try {
    const card = await store.create({
      to: "vrl:node:friend",
      character: "vrl:char:friend-fish",
      text: "今天路过你的鱼缸，她看起来很好。",
    });
    assert.match(card.id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(card.from, identity.publicIdentity().nodeId);
    assert.equal(card.fromName, "A 的缸");
    assert.equal(typeof card.sig, "string");
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].text, "今天路过你的鱼缸，她看起来很好。");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3: grants and postcard APIs", async () => {
  const root = await tempDir();
  const hub = await makeHub(root, "api");
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const other = await new IdentityStore({
    dataDir: path.join(root, "other-node"),
    charactersDir: path.join(root, "other-characters"),
  }).init();
  try {
    await hub.peerStore.upsert({
      nodeId: other.publicIdentity().nodeId,
      nodeCert: other.publicIdentity().cert,
      name: "B",
      grants: { tankView: true, chat: true },
    });

    const grant = await (
      await fetch(`${base}/api/federation/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: other.publicIdentity().nodeId, grant: "chat", value: false }),
      })
    ).json();
    assert.equal(grant.ok, true);
    assert.equal(grant.peer.grants.chat, false);

    const created = await (
      await fetch(`${base}/api/federation/postcards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: other.publicIdentity().nodeId,
          character: "vrl:char:friend",
          text: "你好，路过。",
        }),
      })
    ).json();
    assert.equal(created.ok, true);
    assert.match(created.postcard.id, /^sha256:/);

    const list = await (await fetch(`${base}/api/federation/postcards`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.postcards.length, 1);
    assert.equal(list.postcards[0].text, "你好，路过。");
  } finally {
    await closeHub(hub);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3: UI and federation status are served", async () => {  const root = await tempDir();
  const hub = await makeHub(root, "ui");
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    // 只保留分层式 wx 界面（骨架由 /wx.js 渲染）
    assert.match(html, /\/wx\.js/);

    const wx = await fetch(`${base}/wx`);
    assert.equal(wx.status, 200);
    assert.match(await wx.text(), /\/wx\.js/);
    const wxjs = await fetch(`${base}/wx.js`);
    assert.equal(wxjs.status, 200);
    const wxc = await fetch(`${base}/wx.css`);
    assert.equal(wxc.status, 200);

    // 旧版页面已下线：不再提供（合规：旧文案不随包发布）
    for (const legacy of ["/legacy", "/v2", "/v2.js", "/v2.css", "/app.js", "/style.css"]) {
      const legacyResponse = await fetch(`${base}${legacy}`);
      assert.equal(legacyResponse.status, 404, `${legacy} 应已下线`);
    }

    // 用户可见文案不得出现指向"养鱼"事件或腾讯品牌的术语
    const servedUi = (await (await fetch(`${base}/wx.js`)).text()) + (await (await fetch(`${base}/wx.css`)).text());
    assert.doesNotMatch(servedUi, /养鱼|鱼缸|鱼住|鱼友|微信式|腾讯|QQ/);

    const status = await (await fetch(`${base}/api/federation/status`)).json();
    assert.equal(status.ok, true);
    assert.ok(status.federation.nodeId.startsWith("vrl:node:"));
    assert.equal(status.federation.listening.port, hub.federation.listenAddress.port);
  } finally {
    await closeHub(hub);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
