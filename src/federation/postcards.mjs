import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { publicKeyFromRawEd25519, verifyNodeCertificate } from "./identity.mjs";
import { canonicalJson } from "./events.mjs";

function safeName(value) {
  return `${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}.json`;
}

function postcardBody(postcard) {
  return {
    v: Number(postcard?.v ?? 1),
    from: String(postcard?.from ?? ""),
    fromName: String(postcard?.fromName ?? ""),
    to: String(postcard?.to ?? ""),
    character: String(postcard?.character ?? ""),
    text: String(postcard?.text ?? ""),
    at: Number(postcard?.at ?? 0),
  };
}

export function verifyPostcard(postcard, nodeCert) {
  if (!postcard?.sig || !postcard?.id) return false;
  if (!verifyNodeCertificate(nodeCert)) return false;
  if (postcard.from !== nodeCert.nodeId) return false;
  const body = postcardBody(postcard);
  if (postcardId(body) !== postcard.id) return false;
  try {
    const key = publicKeyFromRawEd25519(nodeCert.signPub);
    return crypto.verify(null, Buffer.from(canonicalJson(body)), key, Buffer.from(postcard.sig, "base64url"));
  } catch {
    return false;
  }
}

function postcardId(body) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

/**
 * A signed, local postcard. M3 keeps these local; sending them over the wire
 * is a later transport concern (the signature makes them verifiable).
 */
export class PostcardStore {
  constructor({ dir, identity, name = "" } = {}) {
    if (!dir) throw new Error("PostcardStore: dir required");
    if (!identity) throw new Error("PostcardStore: identity required");
    this.dir = dir;
    this.identity = identity;
    this.name = name;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  async create({ to, character, text } = {}) {
    const body = {
      v: 1,
      from: this.identity.publicIdentity().nodeId,
      fromName: this.name || this.identity.publicIdentity().fingerprint,
      to: String(to ?? ""),
      character: String(character ?? ""),
      text: String(text ?? "").slice(0, 2000),
      at: Date.now(),
    };
    if (!body.to || !body.character || !body.text) throw new Error("postcard needs to/character/text");
    const postcard = {
      ...body,
      id: postcardId(body),
      sig: this.identity.signDetached(body),
    };
    const file = path.join(this.dir, safeName(postcard.id));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(postcard, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    return postcard;
  }

  async receive(postcard, fromCert) {
    if (!verifyPostcard(postcard, fromCert)) throw new Error("postcard signature invalid");
    const file = path.join(this.dir, safeName(postcard.id));
    try {
      await fs.access(file);
      return { ...postcard, duplicate: true };
    } catch {
      // not present yet
    }
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(postcard, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    return postcard;
  }

  async list() {
    let files = [];
    try {
      files = await fs.readdir(this.dir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const out = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await fs.readFile(path.join(this.dir, file), "utf8")));
      } catch {
        // ignore a corrupt postcard
      }
    }
    return out.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
  }
}
