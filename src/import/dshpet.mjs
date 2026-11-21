// Import a .dshpet (DSH Pet Pack) into a VRlink character.
// Spec: DSH Pet Pack 1.0 — ZIP with pet.json, images (PNG/WebP) and JSON data; no code.
import fs from "node:fs/promises";
import path from "node:path";
import { readZipBuffer } from "./zip.mjs";

const MAX_PACK = 32 * 1024 * 1024;

export async function parseDshpetFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return parseDshpetBuffer(buffer, filePath);
}

export function parseDshpetBuffer(buffer, source = "dshpet") {
  if (buffer.length > MAX_PACK) throw new Error(`dshpet too large: ${buffer.length} > ${MAX_PACK}`);
  const files = readZipBuffer(buffer);
  const pet = files.get("pet.json");
  if (!pet) throw new Error("pet.json missing at zip root");
  let manifest;
  try {
    manifest = parseJson(pet, "pet.json");
  } catch {
    throw new Error("pet.json is not valid JSON");
  }
  if (manifest?.format !== "dsh-pet") throw new Error(`unsupported format: ${manifest?.format}`);
  if (Number(manifest?.formatVersion) !== 1) throw new Error(`unsupported formatVersion: ${manifest?.formatVersion}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(String(manifest.id ?? ""))) throw new Error("invalid pet id");
  if (!manifest.name) throw new Error("pet.name required");
  const assets = manifest.assets ?? {};
  for (const [key, asset] of Object.entries(assets)) {
    if (!asset?.path || !files.has(asset.path)) throw new Error(`asset missing: ${key} -> ${asset?.path}`);
    if (!/\.(png|webp)$/i.test(asset.path)) throw new Error(`unsupported image type: ${asset.path}`);
  }
  const animationsName = manifest.animations ?? "animations.json";
  let animations = [];
  if (files.has(animationsName)) {
    animations = parseJson(files.get(animationsName), animationsName);
    if (!Array.isArray(animations)) throw new Error("animations.json must be an array");
  }
  const dialogueName = manifest.dialogue ?? "dialogue.json";
  let dialogue = {};
  if (files.has(dialogueName)) {
    dialogue = parseJson(files.get(dialogueName), dialogueName);
    if (!dialogue || typeof dialogue !== "object" || Array.isArray(dialogue)) throw new Error("dialogue.json must be an object");
  }
  return { manifest, files, animations, dialogue, source, buffer };
}

export async function importDshpet({ filePath, buffer, store }) {
  const parsed = buffer ? parseDshpetBuffer(buffer, filePath ?? "buffer") : await parseDshpetFile(filePath);
  const baseId = slugify(parsed.manifest.id) || `dshpet_${Date.now().toString(36)}`;
  const existing = new Set((await store.list()).map((character) => character.id));
  let id = baseId;
  let suffix = 2;
  while (existing.has(id)) id = `${baseId}_${suffix++}`;

  const manifest = parsed.manifest;
  const character = await store.create({
    id,
    name: String(manifest.name).slice(0, 24),
    persona: {
      identity: String(manifest.description ?? "从 .dshpet 导入").slice(0, 80),
      baseline: "来自 DSH Pet Pack（表情/动作包）",
      soul: `作者：${manifest.author ?? "未知"}\n版本：${manifest.version ?? "?"}\n${manifest.description ?? ""}`.slice(0, 20000),
    },
    brain: { engine: "mock", model: "mock" },
    "x-vrlink": {
      pet: {
        format: manifest.format,
        formatVersion: manifest.formatVersion,
        sourceId: manifest.id,
        version: manifest.version,
        author: manifest.author ?? "",
        canvas: manifest.canvas ?? null,
        animations: parsed.animations.length,
        capabilities: manifest.capabilities ?? [],
      },
    },
  });

  const thumbnailName = manifest.thumbnail && parsed.files.has(manifest.thumbnail) ? manifest.thumbnail : Object.values(manifest.assets ?? {})[0]?.path;
  if (thumbnailName && parsed.files.has(thumbnailName)) {
    const ext = /\.webp$/i.test(thumbnailName) ? "webp" : "png";
    await store.writeAsset(id, `pets/thumbnail.${ext}`, parsed.files.get(thumbnailName));
  }
  if (parsed.buffer) {
    await store.writeAsset(id, `pets/source.dshpet`, parsed.buffer);
  } else if (filePath) {
    await store.writeAsset(id, "pets/source.dshpet", await fs.readFile(filePath));
  }

  return {
    character,
    sourceId: manifest.id,
    name: manifest.name,
    files: parsed.files.size,
    animations: parsed.animations.length,
    assets: Object.keys(manifest.assets ?? {}).length,
  };
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function parseJson(buffer, name) {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error?.message ?? error}`);
  }
}

export function summarizePack(parsed) {
  return {
    id: parsed.manifest.id,
    name: parsed.manifest.name,
    version: parsed.manifest.version,
    author: parsed.manifest.author ?? "",
    assets: Object.keys(parsed.manifest.assets ?? {}),
    animations: parsed.animations.length,
    files: parsed.files.size,
    bytes: parsed.buffer.length,
  };
}
