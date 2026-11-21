import fs from "node:fs/promises";
import path from "node:path";
import { assert, newId, validateConsent } from "./contracts.mjs";

const ORDER = { low: 0, medium: 1, high: 2, forbidden: 3 };

export class ConsentService {
  constructor(file) {
    this.file = file;
    this.grants = [];
    this.pending = [];
    this.used = new Set();
  }

  async init() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.grants = Array.isArray(raw.grants) ? raw.grants : [];
      this.pending = Array.isArray(raw.pending) ? raw.pending : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.grants = [];
      this.pending = [];
    }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ grants: this.grants, pending: this.pending }, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.file);
  }

  async grant(input) {
    const grant = validateConsent({ ...input, id: input.id ?? newId("consent") });
    this.grants.push(grant);
    await this.save();
    return grant;
  }

  async request(input) {
    const row = {
      id: newId("ask"),
      at: Date.now(),
      characterId: String(input.characterId ?? ""),
      action: String(input.action ?? ""),
      risk: String(input.risk ?? "low"),
      reason: String(input.reason ?? ""),
      status: "pending",
    };
    assert(row.characterId && row.action, "consent request needs characterId + action");
    this.pending.push(row);
    await this.save();
    return row;
  }

  async approve(requestId, { grantedBy = "owner" } = {}) {
    const ask = this.pending.find((item) => item.id === requestId);
    assert(ask, `unknown consent request: ${requestId}`);
    ask.status = "approved";
    const grant = await this.grant({
      characterId: ask.characterId,
      scope: `character:${ask.characterId}`,
      actions: [ask.action],
      riskMax: ask.risk,
      grantedBy,
      oneShot: true,
    });
    await this.save();
    return grant;
  }

  async reject(requestId) {
    const ask = this.pending.find((item) => item.id === requestId);
    if (!ask) return { ok: false };
    ask.status = "rejected";
    await this.save();
    return { ok: true };
  }

  async revoke(grantId) {
    const grant = this.grants.find((item) => item.id === grantId);
    if (!grant) return { ok: false };
    grant.revoked = true;
    await this.save();
    return { ok: true };
  }

  list(characterId) {
    return this.grants.filter((grant) => !characterId || grant.characterId === characterId);
  }

  pendingList(characterId) {
    return this.pending.filter(
      (item) => item.status === "pending" && (!characterId || item.characterId === characterId),
    );
  }

  check({ characterId, action, risk = "low" }) {
    if (risk === "forbidden") return { ok: false, reason: "forbidden" };
    const active = this.grants.filter((grant) => {
      if (grant.revoked) return false;
      if (grant.characterId !== characterId) return false;
      if (grant.expiresAt && Date.now() > grant.expiresAt) return false;
      return true;
    });
    const match = active.find((grant) => {
      if (ORDER[risk] > ORDER[grant.riskMax]) return false;
      return grant.actions.includes("*") || grant.actions.includes(action);
    });
    if (match) return { ok: true, grantId: match.id };
    if (risk === "low") return { ok: false, reason: "no low-risk grant" };
    return { ok: false, requiresApproval: true, reason: `${risk} risk requires approval` };
  }

  async consume(grantId, { characterId, action } = {}) {
    const grant = this.grants.find((item) => item.id === grantId);
    if (!grant || grant.revoked) return false;
    if (characterId && grant.characterId !== characterId) return false;
    if (action && !grant.actions.includes("*") && !grant.actions.includes(action)) return false;
    if (grant.oneShot) {
      if (this.used.has(grant.id)) return false;
      this.used.add(grant.id);
      grant.revoked = true;
      await this.save();
    }
    return true;
  }
}
