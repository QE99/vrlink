#!/usr/bin/env node
// Import a .dshpet (DSH Pet Pack 1.0) into VRlink's local character store.
// Usage: npm run import:dshpet -- "C:\path\to\pet.dshpet"
import path from "node:path";
import { CharacterStore } from "../src/character-store.mjs";
import { importDshpet } from "../src/import/dshpet.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run import:dshpet -- <pet.dshpet>");
  process.exit(2);
}
const dataDir = process.env.VRLINK_V2_DATA || path.join(process.cwd(), "data");
const store = new CharacterStore(path.join(dataDir, "characters"));
await store.init({ seed: false });
try {
  const result = await importDshpet({ filePath: file, store });
  console.log(JSON.stringify({
    ok: true,
    characterId: result.character.id,
    sourceId: result.sourceId,
    name: result.name,
    files: result.files,
    animations: result.animations,
    assets: result.assets,
  }, null, 2));
  console.log(`imported: ${result.character.name} (${result.character.id})`);
} catch (error) {
  console.error(`import failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
