#!/usr/bin/env node
/**
 * M0 migration / verification helper.
 *
 * Usage:
 *   npm run migrate:sign
 *   npm run migrate:sign -- D:\path\to\data
 *
 * What it does:
 * - creates the node identity if missing (data/node/identity.json)
 * - creates per-character identity keys if missing (data/characters/<id>/keys/)
 * - appends a signed `log.genesis` to legacy logs (does not rewrite old events)
 * - verifies each character's signed chain
 *
 * It does not start the Hub, does not call a model, and does not touch network.
 */
import path from "node:path";

import { CharacterStore } from "../src/character-store.mjs";
import { IdentityStore } from "../src/federation/identity.mjs";
import { EventLog } from "../src/event-log.mjs";

const dataDir = path.resolve(process.argv[2] ?? process.env.VRLINK_V2_DATA ?? path.join(process.cwd(), "data"));
const charactersDir = path.join(dataDir, "characters");

const store = new CharacterStore(charactersDir);
await store.init({ seed: false });
const identity = await new IdentityStore({
  dataDir: path.join(dataDir, "node"),
  charactersDir,
  passphrase: process.env.VRLINK_NODE_PASSPHRASE ?? "",
}).init();
const eventLog = new EventLog(charactersDir, { signer: identity });

const node = identity.publicIdentity();
console.log(`Data:        ${dataDir}`);
console.log(`Node:        ${node.nodeId}`);
console.log(`Fingerprint: ${node.fingerprint}`);
console.log("");

let failed = 0;
for (const character of await store.list()) {
  try {
    const migration = await eventLog.ensureSigned(character.id);
    const events = await eventLog.read(character.id);
    const verification = await identity.verifyChain(character.id, events);
    const keys = await identity.ensureCharacter(character.id);
    const state = verification.ok
      ? `OK signed=${verification.signedCount} legacy=${verification.legacyCount}`
      : verification.code === "NO_SIGNED_EVENTS"
        ? `legacy-only (${verification.legacyCount} events)`
        : `FAIL ${verification.code}`;
    console.log(`${character.id} (${character.name})`);
    console.log(`  char:     ${keys.charId}`);
    console.log(`  node:     ${keys.cert.node}`);
    console.log(`  migrate:  created=${Boolean(migration.created)} signed=${Boolean(migration.signed)}`);
    console.log(`  verify:   ${state}`);
    if (!verification.ok && verification.code !== "NO_SIGNED_EVENTS") failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`${character.id} (${character.name})`);
    console.log(`  FAIL: ${error?.code ?? ""} ${error?.message ?? error}`);
  }
}

console.log("");
console.log(failed ? `RESULT: FAIL (${failed})` : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
