import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeId } from "../contracts.mjs";
import {
  canonicalJson,
  signEvent as signEventObject,
  verifyEvent as verifyEventObject,
  verifyEventChain,
} from "./events.mjs";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function base58Encode(buffer) {
  if (!buffer.length) return "";
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros += 1;
  let value = BigInt(`0x${buffer.toString("hex") || "0"}`);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function rawPublicBytes(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  if (!jwk?.x) throw new Error("key does not export an x coordinate");
  return Buffer.from(jwk.x, "base64url");
}

function publicPem(keyObject) {
  return keyObject.export({ type: "spki", format: "pem" });
}

function privatePem(keyObject, passphrase) {
  const options = { type: "pkcs8", format: "pem" };
  if (passphrase) {
    options.cipher = "aes-256-cbc";
    options.passphrase = passphrase;
  }
  return keyObject.export(options);
}

function importPrivateKey(pem, passphrase) {
  try {
    return crypto.createPrivateKey({ key: pem, format: "pem", passphrase: passphrase || undefined });
  } catch (error) {
    if (passphrase) {
      const wrapped = new Error("node key is locked: passphrase is wrong or missing");
      wrapped.code = "NODE_KEY_LOCKED";
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function importPublicKey(pem) {
  return crypto.createPublicKey({ key: pem, format: "pem" });
}

function signJson(privateKey, value) {
  return crypto.sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64url");
}

function verifyJson(publicKey, value, signature) {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      publicKey,
      Buffer.from(String(signature ?? ""), "base64url"),
    );
  } catch {
    return false;
  }
}

export function publicKeyFromRawEd25519(rawBase64url) {
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: String(rawBase64url ?? "") },
    format: "jwk",
  });
}

function withoutSig(value) {
  const { sig: _sig, ...rest } = value ?? {};
  return rest;
}

/**
 * Self-contained node certificate:
 *   nodeId = vrl:node:base58(ed25519 pub)
 *   signPub = raw ed25519 pub (base64url)
 *   sig = ed25519(canonical(body))
 *
 * A verifier can check it without any prior connection or directory.
 */
export function verifyNodeCertificate(cert) {
  if (!cert || typeof cert.nodeId !== "string" || typeof cert.signPub !== "string" || typeof cert.sig !== "string") {
    return false;
  }
  let publicKey;
  try {
    publicKey = publicKeyFromRawEd25519(cert.signPub);
  } catch {
    return false;
  }
  if (nodeIdFrom({ sign: { publicKey } }) !== cert.nodeId) return false;
  return verifyJson(publicKey, withoutSig(cert), cert.sig);
}

export function verifyCharacterCertificate(cert, nodeCert) {
  if (!cert || !nodeCert || cert.node !== nodeCert.nodeId) return false;
  if (!verifyNodeCertificate(nodeCert)) return false;
  let nodePublicKey;
  let charPublicKey;
  try {
    nodePublicKey = publicKeyFromRawEd25519(nodeCert.signPub);
    charPublicKey = publicKeyFromRawEd25519(cert.charSignPub);
  } catch {
    return false;
  }
  const { sigNode, ...body } = cert;
  if (!verifyJson(nodePublicKey, body, sigNode)) return false;
  return charIdFrom({ sign: { publicKey: charPublicKey } }) === cert.char;
}

/**
 * Verify an event from another node using only its certificates. This is the
 * primitive M1 will use after a handshake; M0 already uses it in tests to prove
 * that two independently-keyed nodes can verify each other's events.
 */
export function verifyCertifiedEvent(event, charCert, nodeCert) {
  if (!verifyCharacterCertificate(charCert, nodeCert)) {
    return { ok: false, code: "BAD_CERT", reason: "character/node certificate invalid" };
  }
  if (event?.char !== charCert.char) return { ok: false, code: "WRONG_CHAR" };
  if (event?.origin !== nodeCert.nodeId) return { ok: false, code: "WRONG_ORIGIN" };
  let charPublicKey;
  try {
    charPublicKey = publicKeyFromRawEd25519(charCert.charSignPub);
  } catch {
    return { ok: false, code: "BAD_CERT", reason: "character public key invalid" };
  }
  return verifyEventObject(event, charPublicKey);
}


function newNodeKeys() {
  return {
    sign: crypto.generateKeyPairSync("ed25519"),
    enc: crypto.generateKeyPairSync("x25519"),
  };
}

function nodeIdFrom(keys) {
  return `vrl:node:${base58Encode(rawPublicBytes(keys.sign.publicKey))}`;
}

function charIdFrom(keys) {
  return `vrl:char:${base58Encode(rawPublicBytes(keys.sign.publicKey))}`;
}

function fingerprintFrom(signPublicKey) {
  return base32Encode(sha256(rawPublicBytes(signPublicKey))).slice(0, 10);
}

/**
 * Self-sovereign node + character keys.
 *
 * M0 scope:
 * - node key: Ed25519 (signing) + X25519 (encryption), derived/stored together
 * - character key: independent Ed25519 + X25519, certified by the node
 * - optional passphrase-at-rest (VRLINK_NODE_PASSPHRASE)
 * - no network, no central account
 */
export class IdentityStore {
  constructor({ dataDir, charactersDir, passphrase = "" } = {}) {
    if (!dataDir) throw new Error("IdentityStore: dataDir required");
    if (!charactersDir) throw new Error("IdentityStore: charactersDir required");
    this.dataDir = dataDir;
    this.charactersDir = charactersDir;
    this.passphrase = String(passphrase ?? "");
    this.nodeId = "";
    this.fingerprint = "";
    this.createdAt = 0;
    this.nodeCert = null;
    this.nodeSignPublic = null;
    this.nodeSignPrivate = null;
    this.nodeEncPublic = null;
    this.nodeEncPrivate = null;
    this.characterCache = new Map();
    this.characterLocks = new Map();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await fs.mkdir(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, "identity.json");
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (payload) {
      await this.#loadIdentity(payload, file);
    } else {
      await this.#createIdentity(file);
    }
    this.initialized = true;
    return this;
  }

  async #createIdentity(file) {
    const keys = newNodeKeys();
    const nodeId = nodeIdFrom(keys);
    const createdAt = Date.now();
    const encPub = rawPublicBytes(keys.enc.publicKey).toString("base64url");
    const certBody = {
      v: 1,
      nodeId,
      signPub: rawPublicBytes(keys.sign.publicKey).toString("base64url"),
      encPub,
      createdAt,
    };
    const cert = { ...certBody, sig: signJson(keys.sign.privateKey, certBody) };
    const payload = {
      v: 1,
      nodeId,
      fingerprint: fingerprintFrom(keys.sign.publicKey),
      createdAt,
      encrypted: Boolean(this.passphrase),
      sign: {
        publicKey: publicPem(keys.sign.publicKey),
        privateKey: privatePem(keys.sign.privateKey, this.passphrase),
      },
      enc: {
        publicKey: publicPem(keys.enc.publicKey),
        privateKey: privatePem(keys.enc.privateKey, this.passphrase),
      },
      cert,
    };
    await this.#writeAtomic(file, payload);
    await this.#applyIdentity(payload, keys.sign.privateKey, keys.enc.privateKey, keys.sign.publicKey, keys.enc.publicKey);
  }

  async #loadIdentity(payload, file) {
    if (!payload?.nodeId || !payload?.sign?.publicKey || !payload?.sign?.privateKey) {
      throw new Error(`identity file is incomplete: ${file}`);
    }
    if (payload.encrypted && !this.passphrase) {
      const error = new Error("node key is locked: set VRLINK_NODE_PASSPHRASE");
      error.code = "NODE_KEY_LOCKED";
      throw error;
    }
    const signPrivate = importPrivateKey(payload.sign.privateKey, this.passphrase);
    const encPrivate = importPrivateKey(payload.enc.privateKey, this.passphrase);
    const signPublic = importPublicKey(payload.sign.publicKey);
    const encPublic = importPublicKey(payload.enc.publicKey);
    const nodeId = nodeIdFrom({ sign: { publicKey: signPublic } });
    if (payload.nodeId !== nodeId) throw new Error("identity file nodeId does not match its public key");
    const cert = payload.cert;
    if (!cert || cert.nodeId !== nodeId || !verifyNodeCertificate(cert)) {
      throw new Error("identity file cert is missing or invalid");
    }
    await this.#applyIdentity(payload, signPrivate, encPrivate, signPublic, encPublic);
  }

  async #applyIdentity(payload, signPrivate, encPrivate, signPublic, encPublic) {
    this.nodeId = payload.nodeId;
    this.fingerprint = payload.fingerprint ?? fingerprintFrom(signPublic);
    this.createdAt = Number(payload.createdAt ?? 0);
    this.nodeCert = payload.cert;
    this.nodeSignPublic = signPublic;
    this.nodeSignPrivate = signPrivate;
    this.nodeEncPublic = encPublic;
    this.nodeEncPrivate = encPrivate;
  }

  publicIdentity() {
    if (!this.initialized) throw new Error("IdentityStore not initialized");
    return {
      nodeId: this.nodeId,
      fingerprint: this.fingerprint,
      createdAt: this.createdAt,
      cert: this.nodeCert,
      signPublicKey: publicPem(this.nodeSignPublic),
      encPublicKey: publicPem(this.nodeEncPublic),
    };
  }

  #characterDir(characterId) {
    return path.join(this.charactersDir, normalizeId(characterId), "keys");
  }

  async ensureCharacter(characterId, options = {}) {
    if (!this.initialized) throw new Error("IdentityStore not initialized");
    const localId = normalizeId(characterId);
    const cached = this.characterCache.get(localId);
    if (cached) return cached;
    const previous = this.characterLocks.get(localId) ?? Promise.resolve();
    const current = previous.then(
      () => this.#ensureCharacterLocked(localId, options),
      () => this.#ensureCharacterLocked(localId, options),
    );
    this.characterLocks.set(localId, current.catch(() => {}));
    return current;
  }

  async #ensureCharacterLocked(localId, { name } = {}) {
    const cached = this.characterCache.get(localId);
    if (cached) return cached;

    const dir = this.#characterDir(localId);
    const file = path.join(dir, "char-identity.json");
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (!payload) {
      const displayName = await this.#characterName(localId, name);
      const pairs = newNodeKeys();
      const keys = {
        localId,
        charId: charIdFrom(pairs),
        cert: null,
        signPublicKey: pairs.sign.publicKey,
        signPrivateKey: pairs.sign.privateKey,
        encPublicKey: pairs.enc.publicKey,
        encPrivateKey: pairs.enc.privateKey,
      };
      const cert = this.#issueCharacterCert(localId, keys, displayName);
      keys.cert = cert;
      payload = {
        v: 1,
        localId,
        charId: keys.charId,
        createdAt: Date.now(),
        encrypted: Boolean(this.passphrase),
        sign: {
          publicKey: publicPem(keys.signPublicKey),
          privateKey: privatePem(keys.signPrivateKey, this.passphrase),
        },
        enc: {
          publicKey: publicPem(keys.encPublicKey),
          privateKey: privatePem(keys.encPrivateKey, this.passphrase),
        },
        cert,
      };
      await fs.mkdir(dir, { recursive: true });
      await this.#writeAtomic(file, payload);
      this.characterCache.set(localId, keys);
      return keys;
    }

    const keys = this.#readCharacterKeys(payload);
    let cert = payload.cert;
    if (!this.#certValidForNode(cert, keys.charId)) {
      // A character imported from another node keeps its character identity
      // key, but the new node must issue its own cert. Cross-node transfer
      // receipts are a later milestone; M0 only re-certifies locally.
      cert = this.#issueCharacterCert(localId, keys, cert?.name || (await this.#characterName(localId)));
      payload.cert = cert;
      await this.#writeAtomic(file, payload);
    }
    keys.cert = cert;
    this.characterCache.set(localId, keys);
    return keys;
  }

  async #characterName(localId, preferred = "") {
    if (preferred) return String(preferred).slice(0, 80);
    try {
      const character = JSON.parse(await fs.readFile(path.join(this.charactersDir, localId, "character.json"), "utf8"));
      if (character?.name) return String(character.name).slice(0, 80);
    } catch {
      // fall through
    }
    return localId;
  }

  #issueCharacterCert(localId, keys, name) {
    const charEncPub = rawPublicBytes(keys.encPublicKey).toString("base64url");
    const nodeEncPub = rawPublicBytes(this.nodeEncPublic).toString("base64url");
    const body = {
      v: 1,
      localId,
      char: keys.charId,
      charSignPub: rawPublicBytes(keys.signPublicKey).toString("base64url"),
      charEncPub,
      node: this.nodeId,
      nodeEncPub,
      name,
      createdAt: Date.now(),
    };
    return { ...body, sigNode: signJson(this.nodeSignPrivate, body) };
  }

  #certValidForNode(cert, charId) {
    if (!cert || cert.char !== charId || cert.node !== this.nodeId) return false;
    return verifyCharacterCertificate(cert, this.nodeCert);
  }

  #readCharacterKeys(payload) {
    if (payload.encrypted && !this.passphrase) {
      const error = new Error("character key is locked: set VRLINK_NODE_PASSPHRASE");
      error.code = "NODE_KEY_LOCKED";
      throw error;
    }
    const signPrivate = importPrivateKey(payload.sign.privateKey, this.passphrase);
    const encPrivate = importPrivateKey(payload.enc.privateKey, this.passphrase);
    const signPublic = importPublicKey(payload.sign.publicKey);
    const encPublic = importPublicKey(payload.enc.publicKey);
    const charId = charIdFrom({ sign: { publicKey: signPublic } });
    if (payload.charId !== charId) throw new Error("character key id does not match its public key");
    return {
      localId: payload.localId,
      charId,
      cert: payload.cert,
      signPublicKey: signPublic,
      signPrivateKey: signPrivate,
      encPublicKey: encPublic,
      encPrivateKey: encPrivate,
    };
  }

  async publicCharacter(characterId) {
    const keys = await this.ensureCharacter(characterId);
    return {
      localId: keys.localId,
      charId: keys.charId,
      cert: keys.cert,
      signPublicKey: publicPem(keys.signPublicKey),
      encPublicKey: publicPem(keys.encPublicKey),
    };
  }

  verifyCharacterCert(cert) {
    if (!cert || cert.node !== this.nodeId) return false;
    return verifyCharacterCertificate(cert, this.nodeCert);
  }

  getNodeCert() {
    return this.nodeCert;
  }

  getNodeEncPrivateKey() {
    return this.nodeEncPrivate;
  }

  getNodeEncPublicRaw() {
    return rawPublicBytes(this.nodeEncPublic).toString("base64url");
  }

  signBytes(data) {
    return crypto.sign(null, Buffer.from(data), this.nodeSignPrivate).toString("base64url");
  }

  signDetached(value) {
    return signJson(this.nodeSignPrivate, value);
  }

  async signEvent({ characterId, event, seq, prev = null }) {
    const keys = await this.ensureCharacter(characterId);
    const body = {
      ...event,
      char: keys.charId,
      origin: this.nodeId,
      seq,
      prev: prev ?? null,
    };
    delete body.id;
    delete body.sig;
    return signEventObject(body, keys.signPrivateKey);
  }

  async verifyEvent(event) {
    const keys = await this.ensureCharacter(event.characterId);
    const result = verifyEventObject(event, keys.signPublicKey);
    if (!result.ok) return result;
    if (event.char !== keys.charId) return { ok: false, code: "WRONG_CHAR" };
    return result;
  }

  async verifyChain(characterId, events) {
    const keys = await this.ensureCharacter(characterId);
    return verifyEventChain(events, keys.signPublicKey, { charId: keys.charId, origin: this.nodeId });
  }

  async #writeAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code) || attempt === 4) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
