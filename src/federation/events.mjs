import crypto from "node:crypto";

/**
 * Canonical JSON for signing (v1).
 *
 * This is deliberately small and strict: object keys are sorted, arrays keep
 * their order, and only JSON-safe values are allowed. It is not a full RFC 8785
 * implementation; it is the stable subset VRlink events use. If the event
 * schema grows numbers with exotic forms, revisit this before v2.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function eventBody(event) {
  const { id: _id, sig: _sig, ...body } = event ?? {};
  return body;
}

export function computeEventId(event) {
  return `sha256:${sha256Hex(canonicalJson(eventBody(event)))}`;
}

export function signEvent(event, privateKey) {
  const body = eventBody(event);
  const id = `sha256:${sha256Hex(canonicalJson(body))}`;
  const sig = crypto.sign(null, Buffer.from(id, "utf8"), privateKey).toString("base64url");
  return { ...body, id, sig };
}

export function verifyEvent(event, publicKey) {
  if (!event || typeof event.id !== "string" || typeof event.sig !== "string") {
    return { ok: false, code: "UNSIGNED", reason: "event has no id/sig" };
  }
  const body = eventBody(event);
  const expected = `sha256:${sha256Hex(canonicalJson(body))}`;
  if (expected !== event.id) return { ok: false, code: "ID_MISMATCH", reason: "event id does not match content" };
  const ok = crypto.verify(
    null,
    Buffer.from(event.id, "utf8"),
    publicKey,
    Buffer.from(event.sig, "base64url"),
  );
  return ok ? { ok: true, id: event.id } : { ok: false, code: "BAD_SIGNATURE", reason: "signature mismatch" };
}

export function isSignedEvent(event) {
  return Boolean(
    event &&
      typeof event.id === "string" &&
      typeof event.sig === "string" &&
      Number.isInteger(event.seq) &&
      typeof event.origin === "string" &&
      typeof event.char === "string",
  );
}

export function isGenesisEvent(event) {
  return Boolean(
    event &&
      event.type === "log.genesis" &&
      event.visibility === "internal" &&
      event.content &&
      Number.isInteger(event.content.legacyCount),
  );
}

/**
 * Verify a single-writer, hash-chained event log.
 * Legacy (unsigned) events are allowed only before the first signed event, and
 * that first signed event must be a genesis record carrying their digest/count.
 */
export function verifyEventChain(events, publicKey, { charId, origin } = {}) {
  const list = Array.isArray(events) ? events : [];
  const signed = [];
  let legacyCount = 0;
  let seenSigned = false;

  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    if (isSignedEvent(event)) {
      seenSigned = true;
      signed.push({ event, index: i });
    } else if (!seenSigned) {
      legacyCount += 1;
    } else {
      return {
        ok: false,
        code: "UNSIGNED_AFTER_SIGNED",
        reason: "unsigned event found after the signed chain started",
        index: i,
      };
    }
  }

  if (!signed.length) {
    return { ok: false, code: "NO_SIGNED_EVENTS", reason: "log has no signed events yet", legacyCount };
  }

  if (legacyCount > 0) {
    const first = signed[0].event;
    if (!isGenesisEvent(first)) {
      return {
        ok: false,
        code: "MISSING_GENESIS",
        reason: "legacy events exist but the first signed event is not log.genesis",
        legacyCount,
      };
    }
    if (first.content.legacyCount !== legacyCount) {
      return {
        ok: false,
        code: "LEGACY_COUNT_MISMATCH",
        expected: legacyCount,
        got: first.content.legacyCount,
      };
    }
    if (typeof first.content.legacyDigest !== "string" || !first.content.legacyDigest) {
      return { ok: false, code: "MISSING_LEGACY_DIGEST", reason: "genesis has no legacyDigest" };
    }
    const legacyEvents = list.slice(0, legacyCount);
    const expectedDigest = `sha256:${sha256Hex(canonicalJson(legacyEvents))}`;
    if (first.content.legacyDigest !== expectedDigest) {
      return {
        ok: false,
        code: "LEGACY_DIGEST_MISMATCH",
        reason: "legacy history does not match the digest recorded in log.genesis",
      };
    }
  }

  let prev = null;
  for (let i = 0; i < signed.length; i += 1) {
    const { event, index } = signed[i];
    if (event.seq !== i + 1) {
      return { ok: false, code: "BAD_SEQ", expected: i + 1, got: event.seq, index };
    }
    if ((event.prev ?? null) !== prev) {
      return { ok: false, code: "BAD_PREV", expected: prev, got: event.prev ?? null, index };
    }
    if (charId && event.char !== charId) {
      return { ok: false, code: "WRONG_CHAR", expected: charId, got: event.char, index };
    }
    if (origin && event.origin !== origin) {
      return { ok: false, code: "WRONG_ORIGIN", expected: origin, got: event.origin, index };
    }
    const result = verifyEvent(event, publicKey);
    if (!result.ok) return { ...result, index };
    prev = event.id;
  }

  return {
    ok: true,
    signedCount: signed.length,
    legacyCount,
    head: prev,
    genesis: legacyCount > 0 ? signed[0].event : null,
  };
}
