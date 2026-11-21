import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { newId, validateEvent } from "./contracts.mjs";
import { isSignedEvent, sha256Hex, canonicalJson } from "./federation/events.mjs";

/**
 * Append-only event log per character.
 * The log is the source of truth; state/memory/conversation are projections.
 *
 * With a signer (IdentityStore), new events are signed and hash-chained:
 *   id = sha256(canonical unsigned event)
 *   prev = previous signed event id
 *   seq = 1, 2, 3...
 * If the existing log is legacy/unsigned, the first signed append injects a
 * `log.genesis` event carrying a digest + count of the legacy history. Old
 * events are never rewritten.
 */
export class EventLog extends EventEmitter {
  constructor(baseDir, { signer = null } = {}) {
    super();
    this.baseDir = baseDir;
    this.signer = signer;
    this.signStates = new Map();
    this.locks = new Map();
  }

  dir(characterId) {
    return path.join(this.baseDir, characterId);
  }

  file(characterId) {
    return path.join(this.dir(characterId), "events.jsonl");
  }

  async ensure(characterId) {
    await fs.mkdir(this.dir(characterId), { recursive: true });
  }

  async append(characterId, event) {
    const normalized = validateEvent({ ...event, characterId });
    if (!this.signer) return this.#appendRaw(characterId, normalized);
    return this.#withLock(characterId, async () => {
      try {
        const signed = await this.#signWithChain(characterId, normalized);
        return await this.#appendRaw(characterId, signed);
      } catch (error) {
        // If signing or writing failed, the cached head may be ahead of disk.
        // Re-read the file on the next append instead of continuing a broken chain.
        this.signStates.delete(characterId);
        throw error;
      }
    });
  }

  async #appendRaw(characterId, event) {
    await this.ensure(characterId);
    await fs.appendFile(this.file(characterId), `${JSON.stringify(event)}\n`, "utf8");
    this.emit("event", event);
    return event;
  }

  async #withLock(characterId, task) {
    const previous = this.locks.get(characterId) ?? Promise.resolve();
    const current = previous.then(task, task);
    // Keep the chain alive after a failed append; the next caller still gets a turn.
    this.locks.set(characterId, current.catch(() => {}));
    return current;
  }

  async #readRawFile(characterId) {
    try {
      return await fs.readFile(this.file(characterId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async #signState(characterId) {
    const cached = this.signStates.get(characterId);
    if (cached) return cached;

    const text = await this.#readRawFile(characterId);
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    let lastSigned = null;
    let legacyCount = 0;
    let seenSigned = false;
    let dirty = false;
    for (const event of events) {
      if (isSignedEvent(event)) {
        seenSigned = true;
        lastSigned = event;
      } else if (!seenSigned) {
        legacyCount += 1;
      } else {
        dirty = true;
      }
    }

    const state = {
      last: lastSigned,
      legacyCount: lastSigned ? 0 : legacyCount,
      legacyDigest: lastSigned || !legacyCount ? null : `sha256:${sha256Hex(canonicalJson(events))}`,
      dirty,
    };
    this.signStates.set(characterId, state);
    return state;
  }

  async #signWithChain(characterId, event) {
    const state = await this.#signState(characterId);
    if (state.dirty) {
      const error = new Error(`event log has unsigned events after the signed chain: ${characterId}`);
      error.code = "EVENT_LOG_DIRTY";
      throw error;
    }

    let seq = 1;
    let prev = null;

    if (state.last) {
      seq = state.last.seq + 1;
      prev = state.last.id;
    } else if (state.legacyCount > 0) {
      await this.#createGenesis(characterId, state);
      seq = 2;
      prev = state.last.id;
    }

    const signed = await this.signer.signEvent({ characterId, event, seq, prev });
    state.last = signed;
    return signed;
  }

  async #createGenesis(characterId, state) {
    const genesis = await this.signer.signEvent({
      characterId,
      event: {
        type: "log.genesis",
        source: { body: "internal", thread: "identity", actor: null },
        visibility: "internal",
        content: {
          legacyDigest: state.legacyDigest,
          legacyCount: state.legacyCount,
        },
      },
      seq: 1,
      prev: null,
    });
    await this.#appendRaw(characterId, genesis);
    state.last = genesis;
    state.legacyCount = 0;
    state.legacyDigest = null;
    return genesis;
  }

  /**
   * Explicit migration: append a signed genesis to a legacy log (if needed)
   * without adding a user event. No-op for new/empty logs and no-signer logs.
   */
  async ensureSigned(characterId) {
    if (!this.signer) return { ok: true, signed: false, created: false, reason: "no-signer" };
    return this.#withLock(characterId, async () => {
      const state = await this.#signState(characterId);
      if (state.dirty) {
        const error = new Error(`event log has unsigned events after the signed chain: ${characterId}`);
        error.code = "EVENT_LOG_DIRTY";
        throw error;
      }
      if (!state.last && state.legacyCount > 0) {
        const genesis = await this.#createGenesis(characterId, state);
        return { ok: true, signed: true, created: true, genesis };
      }
      return { ok: true, signed: Boolean(state.last), created: false };
    });
  }

  async read(characterId, { limit = 0 } = {}) {
    let text = "";
    try {
      text = await fs.readFile(this.file(characterId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return limit > 0 ? events.slice(-limit) : events;
  }

  async replay(characterId, reducer, initial) {
    const events = await this.read(characterId);
    return events.reduce(reducer, initial);
  }

  async last(characterId, n = 1) {
    return this.read(characterId, { limit: n });
  }

  async appendMany(characterId, events) {
    const out = [];
    for (const event of events) out.push(await this.append(characterId, { ...event, characterId }));
    return out;
  }
}

export function makeEvent({ characterId, type, body = "desktop", thread = "main", actor = null, visibility = "private", content = {}, raw = undefined }) {
  return {
    id: newId("evt"),
    characterId,
    at: Date.now(),
    type,
    source: { body, thread, actor },
    visibility,
    content,
    ...(raw === undefined ? {} : { raw }),
  };
}
