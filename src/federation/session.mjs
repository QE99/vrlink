import crypto from "node:crypto";

import {
  publicKeyFromRawEd25519,
  verifyNodeCertificate,
} from "./identity.mjs";
import { canonicalJson, sha256Hex } from "./events.mjs";
import { SecureChannel } from "./wire.mjs";

const VERSION = 1;
const HKDF_INFO = Buffer.from("vrlink/m1", "utf8");
/** 老版本对端（hello 里没有 caps）按这个算：没有 human.v1，人-人通道会自动降级提示。 */
const LEGACY_CAPS = ["events.v1", "chat.v1"];
const DEFAULT_CAPS = ["events.v1", "chat.v1", "human.v1", "pair.sync.v1"];

function rawPublicBytes(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

function x25519PublicFromRaw(raw) {
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: String(raw ?? "") },
    format: "jwk",
  });
}

function sasFromHash(hashHex) {
  const value = BigInt(`0x${hashHex.slice(0, 12)}`) % 1_000_000n;
  return value.toString().padStart(6, "0");
}

function validateHello(hello, expectedRole) {
  if (!hello || hello.v !== VERSION) throw new Error("federation: bad hello version");
  if (hello.role !== expectedRole) throw new Error(`federation: expected ${expectedRole} hello`);
  if (!verifyNodeCertificate(hello.nodeCert)) throw new Error("federation: bad node certificate");
  if (typeof hello.nonce !== "string" || hello.nonce.length < 16) throw new Error("federation: bad nonce");
  if (typeof hello.eph !== "string" || hello.eph.length < 32) throw new Error("federation: bad ephemeral key");
  if (!Array.isArray(hello.hints)) throw new Error("federation: bad hints");
  if (typeof hello.name !== "string") throw new Error("federation: bad name");
  if (hello.caps !== undefined && !Array.isArray(hello.caps)) throw new Error("federation: bad caps");
  return hello;
}

function verifyAuth(cert, transcriptHash, signature) {
  const publicKey = publicKeyFromRawEd25519(cert.signPub);
  return crypto.verify(
    null,
    Buffer.from(transcriptHash, "utf8"),
    publicKey,
    Buffer.from(String(signature ?? ""), "base64url"),
  );
}

/**
 * Authenticated, encrypted direct session.
 *
 * v1 handshake:
 *   hello (node cert + nonce + ephemeral X25519)
 *   auth  (Ed25519 signature over the canonical transcript hash)
 *   SAS   (6 digits from the transcript hash; human confirms first contact)
 *   AES-256-GCM frames with per-direction HKDF keys
 *
 * This is intentionally a small, explicit handshake rather than an unfinished
 * Noise implementation. It uses the same primitives a Noise XX build would use;
 * a future protocol version can swap the transcript without changing callers.
 */
export async function performHandshake({
  stream,
  identity,
  role,
  name = "",
  hints = [],
  caps = DEFAULT_CAPS,
  timeoutMs = 10000,
}) {
  if (!["initiator", "responder"].includes(role)) throw new Error("federation: bad handshake role");
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const localHello = {
    v: VERSION,
    role,
    nodeCert: identity.getNodeCert(),
    nonce: crypto.randomBytes(18).toString("base64url"),
    eph: rawPublicBytes(ephemeral.publicKey).toString("base64url"),
    name: String(name || identity.publicIdentity().fingerprint).slice(0, 80),
    hints: Array.isArray(hints) ? hints : [],
    caps: Array.isArray(caps) ? caps : DEFAULT_CAPS,
  };

  let remoteHello;
  let transcript;
  let transcriptHash;

  if (role === "initiator") {
    stream.send({ t: "hello", hello: localHello });
    const response = await stream.next({ timeoutMs });
    if (response?.t !== "hello") throw new Error("federation: expected hello");
    remoteHello = validateHello(response.hello, "responder");
    transcript = { v: VERSION, initiator: localHello, responder: remoteHello };
    transcriptHash = sha256Hex(canonicalJson(transcript));
    stream.send({ t: "auth", hashSig: identity.signBytes(transcriptHash) });
    const auth = await stream.next({ timeoutMs });
    if (auth?.t !== "auth") throw new Error("federation: expected auth");
    if (!verifyAuth(remoteHello.nodeCert, transcriptHash, auth.hashSig)) {
      throw new Error("federation: peer auth signature invalid");
    }
  } else {
    const response = await stream.next({ timeoutMs });
    if (response?.t !== "hello") throw new Error("federation: expected hello");
    remoteHello = validateHello(response.hello, "initiator");
    stream.send({ t: "hello", hello: localHello });
    transcript = { v: VERSION, initiator: remoteHello, responder: localHello };
    transcriptHash = sha256Hex(canonicalJson(transcript));
    const auth = await stream.next({ timeoutMs });
    if (auth?.t !== "auth") throw new Error("federation: expected auth");
    if (!verifyAuth(remoteHello.nodeCert, transcriptHash, auth.hashSig)) {
      throw new Error("federation: peer auth signature invalid");
    }
    stream.send({ t: "auth", hashSig: identity.signBytes(transcriptHash) });
  }

  if (remoteHello.nodeCert.nodeId === identity.publicIdentity().nodeId) {
    throw new Error("federation: cannot connect to self");
  }

  const localEph = ephemeral;
  const peerEph = x25519PublicFromRaw(remoteHello.eph);
  const shared = crypto.diffieHellman({ privateKey: localEph.privateKey, publicKey: peerEph });
  const okm = Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.from(transcriptHash, "hex"), HKDF_INFO, 64),
  );
  const initiatorToResponder = okm.subarray(0, 32);
  const responderToInitiator = okm.subarray(32, 64);
  const channel =
    role === "initiator"
      ? new SecureChannel(stream, initiatorToResponder, responderToInitiator)
      : new SecureChannel(stream, responderToInitiator, initiatorToResponder);

  return {
    role,
    channel,
    sas: sasFromHash(transcriptHash),
    transcriptHash,
    peer: {
      nodeId: remoteHello.nodeCert.nodeId,
      nodeCert: remoteHello.nodeCert,
      name: remoteHello.name,
      hints: remoteHello.hints,
      caps: Array.isArray(remoteHello.caps) ? remoteHello.caps : LEGACY_CAPS,
    },
  };
}

function verifyPairSig(cert, body, signature) {
  const publicKey = publicKeyFromRawEd25519(cert.signPub);
  return crypto.verify(
    null,
    Buffer.from(canonicalJson(body), "utf8"),
    publicKey,
    Buffer.from(String(signature ?? ""), "base64url"),
  );
}

/**
 * First-contact pairing. Both sides sign the same body; a known peer skips this.
 * `onPair` is called with { sas, peer } on first contact; return false to reject.
 */
export async function establishPeer({
  channel,
  identity,
  role,
  peer,
  sas,
  peerStore,
  name = "",
  caps = DEFAULT_CAPS,
  autoConfirm = false,
  onPair = null,
  timeoutMs = 10000,
}) {
  const localNodeId = identity.publicIdentity().nodeId;
  const localCaps = Array.isArray(caps) ? caps : DEFAULT_CAPS;
  const remoteCaps = Array.isArray(peer.caps) ? peer.caps : [];
  // 新版配对：即使已经认识也走一次 pair.request/accept。
  // 这样"我删了你、你还认识我"时，重连能重新配对（你那边会弹好友申请），
  // 而不是两边状态不一致导致连不上（0.4.4 起）。
  const syncPairing = localCaps.includes("pair.sync.v1") && remoteCaps.includes("pair.sync.v1");

  const known = await peerStore.get(peer.nodeId);
  if (known) {
    if (known.blocked) {
      const error = new Error("federation: peer is blocked");
      error.code = "PEER_BLOCKED";
      throw error;
    }
    if (known.nodeCert?.signPub !== peer.nodeCert.signPub) {
      const error = new Error("federation: peer key changed; manual re-pair required");
      error.code = "PEER_KEY_CHANGED";
      throw error;
    }
    await peerStore.touch(peer.nodeId, { name: peer.name, hints: peer.hints });
    if (!syncPairing) return known;
  }

  if (!known && !autoConfirm) {
    const accepted = onPair ? await onPair({ sas, peer }) : false;
    if (!accepted) {
      const error = new Error("federation: pairing rejected");
      error.code = "PAIR_REJECTED";
      throw error;
    }
  }
  const body =
    role === "initiator"
      ? {
          v: 1,
          initiator: localNodeId,
          responder: peer.nodeId,
          initiatorName: name,
          responderName: peer.name,
          initiatorCaps: caps,
          responderCaps: peer.caps,
          at: Date.now(),
        }
      : null;

  if (role === "initiator") {
    const localSig = identity.signDetached(body);
    channel.send({ t: "pair.request", body, sig: localSig });
    const response = await channel.next({ timeoutMs });
    if (response?.t !== "pair.accept") throw new Error("federation: expected pair.accept");
    if (response.body?.initiator !== body.initiator || response.body?.responder !== body.responder) {
      throw new Error("federation: pair body mismatch");
    }
    if (!verifyPairSig(peer.nodeCert, response.body, response.sig)) {
      throw new Error("federation: pair.accept signature invalid");
    }
    const record = await peerStore.upsert({
      nodeId: peer.nodeId,
      nodeCert: peer.nodeCert,
      name: peer.name,
      hints: peer.hints,
      caps: peer.caps,
      pairedAt: Number(response.body.at ?? Date.now()),
      pairing: { body: response.body, sigLocal: localSig, sigPeer: response.sig },
      grants: { tankView: true, chat: true, human: true },
    });
    channel.send({ t: "pair.done" });
    return record;
  }

  const request = await channel.next({ timeoutMs });
  if (request?.t !== "pair.request") throw new Error("federation: expected pair.request");
  if (!request.body || request.body.initiator !== peer.nodeId || request.body.responder !== localNodeId) {
    throw new Error("federation: pair.request targets another node");
  }
  if (!verifyPairSig(peer.nodeCert, request.body, request.sig)) {
    throw new Error("federation: pair.request signature invalid");
  }
  const localSig = identity.signDetached(request.body);
  const record = await peerStore.upsert({
    nodeId: peer.nodeId,
    nodeCert: peer.nodeCert,
    name: peer.name,
    hints: peer.hints,
    caps: peer.caps,
    pairedAt: Number(request.body.at ?? Date.now()),
    pairing: { body: request.body, sigLocal: localSig, sigPeer: request.sig },
    grants: { tankView: true, chat: true, human: true },
  });
  channel.send({ t: "pair.accept", body: request.body, sig: localSig });
  const done = await channel.next({ timeoutMs });
  if (done?.t !== "pair.done") {
    // Not fatal for the responder; the initiator may have already stored the
    // peer. Keep the channel open, but surface the anomaly.
    // eslint-disable-next-line no-console
    console.warn("federation: pair.done not received");
  }
  return record;
}

export async function rejectPairing(channel) {
  try {
    channel.send({ t: "pair.reject" });
  } catch {
    /* ignore */
  }
  channel.close();
}
