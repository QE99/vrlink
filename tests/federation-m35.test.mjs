import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";
import { createInvite, parseInvite } from "../src/federation/invite.mjs";
import { IdentityStore } from "../src/federation/identity.mjs";
import { PostcardStore, verifyPostcard } from "../src/federation/postcards.mjs";
import { CourierClient, CourierPool, CourierServer } from "../src/federation/courier.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m35-"));
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

test("federation M3.5: invite links round-trip and card JSON is accepted", async () => {
  const root = await tempDir();
  try {
    const identity = await new IdentityStore({
      dataDir: path.join(root, "node"),
      charactersDir: path.join(root, "characters"),
    }).init();
    const card = { node: identity.publicIdentity(), name: "阿鱼的缸", hints: [{ host: "127.0.0.1", port: 5275 }] };
    const invite = createInvite({ card, hints: card.hints, name: card.name });
    assert.match(invite.link, /^vrlink:\/\/connect\?/);
    assert.equal(invite.hints[0].port, 5275);

    const parsed = parseInvite(invite.link);
    assert.equal(parsed.nodeId, card.node.nodeId);
    assert.equal(parsed.name, "阿鱼的缸");
    assert.deepEqual(parsed.hints[0], { host: "127.0.0.1", port: 5275 });

    const fromCard = parseInvite(JSON.stringify(card));
    assert.equal(fromCard.nodeId, card.node.nodeId);
    assert.deepEqual(fromCard.hints[0], { host: "127.0.0.1", port: 5275 });

    assert.throws(() => parseInvite("not-a-target"), /expected/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.5: Hub serves an invite link and QR image", async () => {
  const root = await tempDir();
  const hub = await makeHub(root, "invite");
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const data = await (await fetch(`${base}/api/federation/invite`)).json();
    assert.equal(data.ok, true);
    assert.match(data.invite.link, /^vrlink:\/\/connect\?/);
    assert.ok(data.invite.hints.length >= 1);
    assert.match(data.invite.qr, /^data:image\/png;base64,/);
    assert.ok(data.invite.qr.length > 500);
    assert.equal(data.invite.card.node.nodeId, hub.identity.publicIdentity().nodeId);
  } finally {
    await closeHub(hub);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.5: outgoing postcards are signed and can be received", async () => {
  const root = await tempDir();
  try {
    const a = await new IdentityStore({ dataDir: path.join(root, "a-node"), charactersDir: path.join(root, "a-chars") }).init();
    const b = await new IdentityStore({ dataDir: path.join(root, "b-node"), charactersDir: path.join(root, "b-chars") }).init();
    const outbox = await new PostcardStore({ dir: path.join(root, "a-postcards"), identity: a, name: "A" }).init();
    const inbox = await new PostcardStore({ dir: path.join(root, "b-postcards"), identity: b, name: "B" }).init();
    const card = await outbox.create({
      to: b.publicIdentity().nodeId,
      character: "vrl:char:friend",
      text: "今天路过你的鱼缸。",
    });
    assert.equal(verifyPostcard(card, a.publicIdentity().cert), true);
    assert.equal(verifyPostcard(card, b.publicIdentity().cert), false);
    await inbox.receive(card, a.publicIdentity().cert);
    const list = await inbox.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].text, "今天路过你的鱼缸。");
    await assert.rejects(
      () => inbox.receive({ ...card, text: "tampered" }, a.publicIdentity().cert),
      /signature invalid/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.5: courier pool sends to every courier and dedupes delivery", async () => {
  const root = await tempDir();
  const a = await new IdentityStore({ dataDir: path.join(root, "a-node"), charactersDir: path.join(root, "a-chars") }).init();
  const b = await new IdentityStore({ dataDir: path.join(root, "b-node"), charactersDir: path.join(root, "b-chars") }).init();
  const tokens = { [a.publicIdentity().nodeId]: "token-a", [b.publicIdentity().nodeId]: "token-b" };
  const c1 = new CourierServer({ dataDir: path.join(root, "courier-1"), tokens });
  const c2 = new CourierServer({ dataDir: path.join(root, "courier-2"), tokens });
  const addr1 = await c1.listen(0, "127.0.0.1");
  const addr2 = await c2.listen(0, "127.0.0.1");
  const url1 = `http://127.0.0.1:${addr1.port}`;
  const url2 = `http://127.0.0.1:${addr2.port}`;
  try {
    const pool = new CourierPool({
      identity: a,
      clients: [
        new CourierClient({ url: url1, identity: a, token: "token-a" }),
        new CourierClient({ url: url2, identity: a, token: "token-a" }),
      ],
    });
    const envelope = await pool.send({
      toCert: b.publicIdentity().cert,
      kind: "postcard",
      payload: { postcard: { text: "hello" } },
    });
    assert.match(envelope.id, /^sha256:[a-f0-9]{64}$/);

    const bPool = new CourierPool({
      identity: b,
      clients: [
        new CourierClient({ url: url1, identity: b, token: "token-b" }),
        new CourierClient({ url: url2, identity: b, token: "token-b" }),
      ],
    });
    const items = await bPool.receive();
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "postcard");
    await bPool.ack(envelope.id);
    const afterAck = await bPool.receive();
    assert.equal(afterAck.length, 0);
  } finally {
    await c1.close();
    await c2.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.5: postcards can be delivered through a courier", async () => {
  const root = await tempDir();
  const courier = new CourierServer({ dataDir: path.join(root, "courier"), tokens: {} });
  const address = await courier.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  const a = await createHub({
    dataDir: path.join(root, "a"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir: path.join(root, "a-plugins"),
    federationPort: 0,
    federationName: "A",
    federationAutoAccept: true,
    courierUrls: url,
    courierTokens: "token-a",
    courierPollMs: 300,
  });
  const b = await createHub({
    dataDir: path.join(root, "b"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir: path.join(root, "b-plugins"),
    federationPort: 0,
    federationName: "B",
    federationAutoAccept: true,
    courierUrls: url,
    courierTokens: "token-b",
    courierPollMs: 300,
  });
  try {
    await new Promise((resolve) => a.server.listen(0, "127.0.0.1", resolve));
    const baseA = `http://127.0.0.1:${a.server.address().port}`;
    courier.tokens = {
      [a.identity.publicIdentity().nodeId]: "token-a",
      [b.identity.publicIdentity().nodeId]: "token-b",
    };
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => a.federation.status().sessions.length === 1, { label: "A session" });
    const tank = await waitFor(() => {
      const current = a.federation.remoteTank(b.identity.publicIdentity().nodeId);
      return current?.chars?.length ? current : null;
    }, { label: "remote char" });
    const char = tank.chars[0];
    assert.ok(char);
    const response = await fetch(`${baseA}/api/federation/postcards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: b.identity.publicIdentity().nodeId, character: char.char, text: "经驿站寄一张。" }),
    });
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.delivery.queued, true);
    const received = await waitFor(
      async () => {
        const list = await b.postcardStore.list();
        return list.find((card) => card.text === "经驿站寄一张。");
      },
      { timeoutMs: 5000, label: "postcard received" },
    );
    assert.equal(received.from, a.identity.publicIdentity().nodeId);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await courier.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M3.5: a peer connects by pasting the invite", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  await new Promise((resolve) => a.server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => b.server.listen(0, "127.0.0.1", resolve));
  const baseA = `http://127.0.0.1:${a.server.address().port}`;
  const baseB = `http://127.0.0.1:${b.server.address().port}`;
  try {
    const invite = await (await fetch(`${baseA}/api/federation/invite`)).json();
    const response = await fetch(`${baseB}/api/federation/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: invite.invite.link, autoConfirm: true }),
    });
    const connected = await response.json();
    assert.equal(response.status, 200, JSON.stringify(connected));
    assert.equal(connected.ok, true);
    assert.equal(connected.peer.nodeId, a.identity.publicIdentity().nodeId);
    await waitFor(() => a.federation.status().sessions.length === 1, { label: "A session" });
    await waitFor(() => b.federation.status().sessions.length === 1, { label: "B session" });
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
