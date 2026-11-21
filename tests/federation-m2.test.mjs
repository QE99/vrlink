import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IdentityStore } from "../src/federation/identity.mjs";
import { CourierClient, CourierServer, createEnvelope, openEnvelope } from "../src/federation/courier.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-m2-"));
}

async function makeIdentity(root, name) {
  return new IdentityStore({
    dataDir: path.join(root, `${name}-node`),
    charactersDir: path.join(root, `${name}-characters`),
  }).init();
}

test("federation M2: courier stores only ciphertext and recipient decrypts", async () => {
  const root = await tempDir();
  const a = await makeIdentity(root, "a");
  const b = await makeIdentity(root, "b");
  const courierServer = new CourierServer({
    dataDir: path.join(root, "courier"),
    tokens: {
      [a.publicIdentity().nodeId]: "token-a",
      [b.publicIdentity().nodeId]: "token-b",
    },
  });
  const courier = await courierServer.listen(0, "127.0.0.1");
  const courierUrl = `http://127.0.0.1:${courier.port}`;
  try {
    const clientA = new CourierClient({ url: courierUrl, identity: a, token: "token-a" });
    const clientB = new CourierClient({ url: courierUrl, identity: b, token: "token-b" });
    const envelope = await clientA.send({
      toCert: b.publicIdentity().cert,
      kind: "chat",
      payload: { char: "vrl:char:test", text: "这是一句只能 B 看到的秘密。" },
    });
    assert.match(envelope.id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelope.to, b.publicIdentity().nodeId);

    const files = await fs.readdir(path.join(root, "courier"));
    const raw = (await Promise.all(files.map((file) => fs.readFile(path.join(root, "courier", file), "utf8")))).join(
      "\n",
    );
    assert.equal(raw.includes("这是一句只能 B 看到的秘密。"), false);

    const received = await clientB.receive();
    assert.equal(received.length, 1);
    assert.equal(received[0].error, undefined);
    assert.equal(received[0].kind, "chat");
    assert.equal(received[0].payload.text, "这是一句只能 B 看到的秘密。");
    assert.equal(received[0].from, a.publicIdentity().nodeId);

    await clientB.ack(received[0].id);
    assert.equal((await clientB.fetch()).length, 0);
  } finally {
    await courierServer.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M2: tampered or wrong-recipient envelopes are rejected", async () => {
  const root = await tempDir();
  const a = await makeIdentity(root, "a");
  const b = await makeIdentity(root, "b");
  const c = await makeIdentity(root, "c");
  try {
    const envelope = createEnvelope({
      identity: a,
      toCert: b.publicIdentity().cert,
      kind: "chat",
      payload: { text: "hello" },
    });
    assert.equal(openEnvelope({ envelope, identity: b }).payload.text, "hello");
    assert.throws(() => openEnvelope({ envelope, identity: c }), /not addressed/);

    const tamperedCiphertext = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` };
    assert.throws(() => openEnvelope({ envelope: tamperedCiphertext, identity: b }), /decrypt failed|signature/);

    const tamperedSignature = { ...envelope, sig: "AAAA" };
    assert.throws(() => openEnvelope({ envelope: tamperedSignature, identity: b }), /sender signature/);

    const expired = createEnvelope({
      identity: a,
      toCert: b.publicIdentity().cert,
      payload: { text: "old" },
      expiresAt: Date.now() - 1000,
    });
    assert.throws(() => openEnvelope({ envelope: expired, identity: b }), /expired/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("federation M2: courier auth and recipient quota are enforced", async () => {
  const root = await tempDir();
  const a = await makeIdentity(root, "a");
  const b = await makeIdentity(root, "b");
  const courierServer = new CourierServer({
    dataDir: path.join(root, "courier"),
    tokens: {
      [a.publicIdentity().nodeId]: "token-a",
      [b.publicIdentity().nodeId]: "token-b",
    },
    maxPerRecipient: 1,
  });
  const courier = await courierServer.listen(0, "127.0.0.1");
  const courierUrl = `http://127.0.0.1:${courier.port}`;
  try {
    const anonymous = new CourierClient({ url: courierUrl, identity: a, token: "wrong" });
    await assert.rejects(() => anonymous.fetch(), /401/);

    const clientA = new CourierClient({ url: courierUrl, identity: a, token: "token-a" });
    const clientB = new CourierClient({ url: courierUrl, identity: b, token: "token-b" });
    await clientA.send({ toCert: b.publicIdentity().cert, payload: { text: "one" } });
    await assert.rejects(
      () => clientA.send({ toCert: b.publicIdentity().cert, payload: { text: "two" } }),
      /429|quota/,
    );
  } finally {
    await courierServer.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
