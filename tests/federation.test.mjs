import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IdentityStore, verifyCertifiedEvent, verifyNodeCertificate } from "../src/federation/identity.mjs";
import { canonicalJson, verifyEventChain } from "../src/federation/events.mjs";
import { EventLog } from "../src/event-log.mjs";
import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-fed-"));
}

async function makeIdentity(root, options = {}) {
  return new IdentityStore({
    dataDir: path.join(root, "node"),
    charactersDir: path.join(root, "characters"),
    ...options,
  }).init();
}

test("federation identity: node + character keys are stable and certified", async () => {
  const root = await tempDir();
  const identity = await makeIdentity(root);
  const node = identity.publicIdentity();

  assert.match(node.nodeId, /^vrl:node:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(node.fingerprint.length, 10);
  assert.equal(node.cert.nodeId, node.nodeId);
  assert.equal(node.signPrivateKey, undefined);
  assert.equal(node.encPrivateKey, undefined);

  const character = await identity.ensureCharacter("lin_wan", { name: "林晚" });
  assert.match(character.charId, /^vrl:char:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(character.cert.char, character.charId);
  assert.equal(character.cert.node, node.nodeId);
  assert.equal(identity.verifyCharacterCert(character.cert), true);

  const tamperedCert = { ...character.cert, name: "别人" };
  assert.equal(identity.verifyCharacterCert(tamperedCert), false);

  const identity2 = await makeIdentity(root);
  assert.equal(identity2.publicIdentity().nodeId, node.nodeId);
  const character2 = await identity2.ensureCharacter("lin_wan");
  assert.equal(character2.charId, character.charId);
});

test("federation identity: optional passphrase locks the node key", async () => {
  const root = await tempDir();
  const identity = await makeIdentity(root, { passphrase: "correct horse" });
  const nodeId = identity.publicIdentity().nodeId;

  await assert.rejects(
    () => makeIdentity(root),
    (error) => error.code === "NODE_KEY_LOCKED",
  );
  await assert.rejects(
    () => makeIdentity(root, { passphrase: "wrong horse" }),
    (error) => error.code === "NODE_KEY_LOCKED",
  );

  const reopened = await makeIdentity(root, { passphrase: "correct horse" });
  assert.equal(reopened.publicIdentity().nodeId, nodeId);
});

test("federation identity: imported character keeps charId and gets re-certified", async () => {
  const rootA = await tempDir();
  const identityA = await makeIdentity(rootA);
  const charA = await identityA.ensureCharacter("lin_wan", { name: "林晚" });

  const rootB = await tempDir();
  const identityB = await makeIdentity(rootB);
  const source = path.join(rootA, "characters", "lin_wan", "keys", "char-identity.json");
  const target = path.join(rootB, "characters", "lin_wan", "keys", "char-identity.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);

  const charB = await identityB.ensureCharacter("lin_wan");
  assert.equal(charB.charId, charA.charId);
  assert.equal(charB.cert.node, identityB.publicIdentity().nodeId);
  assert.equal(identityB.verifyCharacterCert(charB.cert), true);
  assert.equal(identityA.verifyCharacterCert(charB.cert), false);
});

test("federation identity: two independent nodes can verify each other's events", async () => {
  const rootA = await tempDir();
  const identityA = await makeIdentity(rootA);
  const nodeA = identityA.publicIdentity();
  const charA = await identityA.ensureCharacter("lin_wan", { name: "林晚" });
  const logA = new EventLog(path.join(rootA, "characters"), { signer: identityA });
  const eventA = await logA.append("lin_wan", {
    type: "message.sent",
    source: { body: "desktop" },
    content: { text: "你好，我是 A 节点的鱼。" },
  });

  const rootB = await tempDir();
  const identityB = await makeIdentity(rootB);
  const nodeB = identityB.publicIdentity();

  assert.equal(verifyNodeCertificate(nodeA.cert), true);
  assert.equal(verifyNodeCertificate({ ...nodeA.cert, signPub: nodeB.cert.signPub }), false);

  const remote = verifyCertifiedEvent(eventA, charA.cert, nodeA.cert);
  assert.equal(remote.ok, true);
  assert.equal(remote.id, eventA.id);

  const tampered = { ...eventA, content: { text: "被改了" } };
  const rejected = verifyCertifiedEvent(tampered, charA.cert, nodeA.cert);
  assert.equal(rejected.ok, false);

  const wrongNode = verifyCertifiedEvent(eventA, charA.cert, nodeB.cert);
  assert.equal(wrongNode.ok, false);
  assert.equal(wrongNode.code, "BAD_CERT");
});

test("federation events: canonical json is stable and sorted", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson([1, "x", null]), '[1,"x",null]');
});

test("federation events: sign, verify, chain, tamper detection", async () => {
  const root = await tempDir();
  const identity = await makeIdentity(root);
  const log = new EventLog(path.join(root, "characters"), { signer: identity });

  const first = await log.append("lin_wan", {
    type: "message.received",
    source: { body: "desktop" },
    content: { text: "在吗" },
  });
  const second = await log.append("lin_wan", {
    type: "message.sent",
    source: { body: "desktop" },
    content: { text: "……嗯。" },
  });

  assert.equal(first.seq, 1);
  assert.equal(first.prev, null);
  assert.match(first.id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof first.sig, "string");
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.id);
  assert.equal(second.char, first.char);
  assert.equal(second.origin, first.origin);

  const events = await log.read("lin_wan");
  assert.equal(events.length, 2);
  const verification = await identity.verifyChain("lin_wan", events);
  assert.equal(verification.ok, true);
  assert.equal(verification.signedCount, 2);
  assert.equal(verification.legacyCount, 0);

  const tampered = { ...first, content: { text: "被改了" } };
  const bad = await identity.verifyEvent(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "ID_MISMATCH");

  const other = await makeIdentity(await tempDir());
  const wrongKey = await other.verifyEvent(first);
  assert.equal(wrongKey.ok, false);
});

test("federation events: legacy log gets a signed genesis, old history stays readable", async () => {
  const root = await tempDir();
  const charactersDir = path.join(root, "characters");
  const legacy = new EventLog(charactersDir);
  await legacy.append("lin_wan", {
    type: "message.received",
    source: { body: "desktop" },
    content: { text: "旧消息 1" },
  });
  await legacy.append("lin_wan", {
    type: "message.sent",
    source: { body: "desktop" },
    content: { text: "旧消息 2" },
  });

  const identity = await makeIdentity(root);
  const signedLog = new EventLog(charactersDir, { signer: identity });
  const fresh = await signedLog.append("lin_wan", {
    type: "message.received",
    source: { body: "desktop" },
    content: { text: "新消息" },
  });

  const events = await signedLog.read("lin_wan");
  assert.equal(events.length, 4);
  assert.equal(events[0].content.text, "旧消息 1");
  assert.equal(events[1].content.text, "旧消息 2");
  assert.equal(events[2].type, "log.genesis");
  assert.equal(events[2].content.legacyCount, 2);
  assert.match(events[2].content.legacyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fresh.seq, 2);
  assert.equal(fresh.prev, events[2].id);

  const verification = await identity.verifyChain("lin_wan", events);
  assert.equal(verification.ok, true);
  assert.equal(verification.legacyCount, 2);
  assert.equal(verification.signedCount, 2);

  const tamperedGenesis = events.map((event) =>
    event.type === "log.genesis" ? { ...event, content: { ...event.content, legacyCount: 99 } } : event,
  );
  const failed = await identity.verifyChain("lin_wan", tamperedGenesis);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "LEGACY_COUNT_MISMATCH");

  const tamperedLegacy = events.map((event) =>
    event.content?.text === "旧消息 1" ? { ...event, content: { ...event.content, text: "被改的旧消息" } } : event,
  );
  const legacyFailed = await identity.verifyChain("lin_wan", tamperedLegacy);
  assert.equal(legacyFailed.ok, false);
  assert.equal(legacyFailed.code, "LEGACY_DIGEST_MISMATCH");
});

test("federation events: explicit ensureSigned migrates legacy without a user event", async () => {
  const root = await tempDir();
  const charactersDir = path.join(root, "characters");
  const legacy = new EventLog(charactersDir);
  await legacy.append("lin_wan", {
    type: "message.received",
    source: { body: "desktop" },
    content: { text: "旧消息" },
  });

  const identity = await makeIdentity(root);
  const signedLog = new EventLog(charactersDir, { signer: identity });
  const first = await signedLog.ensureSigned("lin_wan");
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.genesis.type, "log.genesis");

  const events = await signedLog.read("lin_wan");
  assert.equal(events.length, 2);
  const verification = await identity.verifyChain("lin_wan", events);
  assert.equal(verification.ok, true);
  assert.equal(verification.signedCount, 1);
  assert.equal(verification.legacyCount, 1);

  const second = await signedLog.ensureSigned("lin_wan");
  assert.equal(second.created, false);
  assert.equal((await signedLog.read("lin_wan")).length, 2);

  const next = await signedLog.append("lin_wan", {
    type: "message.sent",
    source: { body: "desktop" },
    content: { text: "新消息" },
  });
  assert.equal(next.seq, 2);
});

test("federation events: unsigned event after signed chain is rejected", async () => {
  const root = await tempDir();
  const charactersDir = path.join(root, "characters");
  const identity = await makeIdentity(root);
  const log = new EventLog(charactersDir, { signer: identity });
  await log.append("lin_wan", {
    type: "message.received",
    source: { body: "desktop" },
    content: { text: "signed" },
  });

  const file = path.join(charactersDir, "lin_wan", "events.jsonl");
  await fs.appendFile(
    file,
    `${JSON.stringify({
      characterId: "lin_wan",
      type: "message.received",
      source: { body: "desktop" },
      at: Date.now(),
      visibility: "private",
      content: { text: "unsigned" },
    })}\n`,
    "utf8",
  );

  const freshLog = new EventLog(charactersDir, { signer: identity });
  await assert.rejects(
    () =>
      freshLog.append("lin_wan", {
        type: "message.received",
        source: { body: "desktop" },
        content: { text: "next" },
      }),
    (error) => error.code === "EVENT_LOG_DIRTY",
  );

  const events = await freshLog.read("lin_wan");
  const verification = await identity.verifyChain("lin_wan", events);
  assert.equal(verification.ok, false);
  assert.equal(verification.code, "UNSIGNED_AFTER_SIGNED");
});

test("federation hub: identity endpoints and signed chat events", async () => {
  const root = await tempDir();
  const hub = await createHub({
    dataDir: root,
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir: path.join(process.cwd(), "plugins"),
  });
  await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const identity = await (await fetch(`${base}/api/identity`)).json();
    assert.equal(identity.ok, true);
    assert.match(identity.node.nodeId, /^vrl:node:/);
    assert.equal(identity.node.signPrivateKey, undefined);

    const list = await (await fetch(`${base}/api/characters`)).json();
    assert.ok(list.characters.length >= 1);
    const id = list.characters[0].id;

    const characterIdentity = await (await fetch(`${base}/api/characters/${id}/identity`)).json();
    assert.equal(characterIdentity.ok, true);
    assert.equal(characterIdentity.identity.cert.node, identity.node.nodeId);

    const chat = await fetch(`${base}/api/characters/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    assert.equal(chat.status, 200);

    const events = await (await fetch(`${base}/api/characters/${id}/events`)).json();
    assert.ok(events.events.some((event) => event.type === "message.received" && event.sig));
    assert.ok(events.events.some((event) => event.type === "message.sent" && event.sig));

    const verify = await (await fetch(`${base}/api/characters/${id}/verify`)).json();
    assert.equal(verify.ok, true);
    assert.equal(verify.verified, true);
    assert.ok(verify.verification.signedCount >= 2);
    assert.equal(verify.verification.legacyCount, 0);
  } finally {
    await hub.pluginHost.close();
    await new Promise((resolve) => hub.server.close(resolve));
  }
});
