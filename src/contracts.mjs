// VRlink v2 contracts: the smallest stable language between core, plugins, bodies, devices and AGI.
// No dependencies. Throw on invalid input.

export const EVENT_TYPES = new Set([
  "message.received",
  "message.sent",
  "message.draft",
  "thought",
  "action.requested",
  "action.result",
  "device.state",
  "system",
  "log.genesis",
]);

export const VISIBILITIES = new Set(["private", "group", "public", "internal"]);
export const RISKS = ["low", "medium", "high", "forbidden"];
export const PLUGIN_TYPES = new Set(["data", "panel", "code", "adapter", "brain", "device"]);

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeId(value, field = "id") {
  const id = String(value ?? "").trim();
  assert(/^[a-z0-9][a-z0-9_-]{1,40}$/.test(id), `${field} must match ^[a-z0-9][a-z0-9_-]{1,40}$`);
  return id;
}

export function validateEvent(event) {
  assert(isPlainObject(event), "event must be an object");
  assert(typeof event.characterId === "string" && event.characterId, "event.characterId required");
  assert(typeof event.type === "string" && EVENT_TYPES.has(event.type), `unknown event.type: ${event.type}`);
  assert(isPlainObject(event.source), "event.source required");
  assert(typeof event.source.body === "string" && event.source.body, "event.source.body required");
  assert(VISIBILITIES.has(event.visibility ?? "private"), `unknown visibility: ${event.visibility}`);
  assert(isPlainObject(event.content ?? {}), "event.content must be an object");
  return {
    ...event,
    id: event.id ?? newId("evt"),
    at: Number.isFinite(event.at) ? event.at : Date.now(),
    visibility: event.visibility ?? "private",
    content: event.content ?? {},
  };
}

export function validateCharacter(character) {
  assert(isPlainObject(character), "character must be an object");
  const id = normalizeId(character.id);
  assert(typeof character.name === "string" && character.name.trim(), "character.name required");
  assert(isPlainObject(character.persona ?? {}), "character.persona must be an object");
  assert(isPlainObject(character.brain ?? {}), "character.brain must be an object");
  assert(Array.isArray(character.bodies ?? []), "character.bodies must be an array");
  return {
    ...character,
    id,
    persona: character.persona ?? {},
    brain: character.brain ?? { engine: "mock", model: "mock" },
    bodies: character.bodies ?? [],
    createdAt: character.createdAt ?? new Date().toISOString(),
    updatedAt: character.updatedAt ?? new Date().toISOString(),
  };
}

export function validateAction(action) {
  assert(isPlainObject(action), "action must be an object");
  assert(typeof action.characterId === "string" && action.characterId, "action.characterId required");
  assert(typeof action.type === "string" && action.type, "action.type required");
  assert(isPlainObject(action.target ?? {}), "action.target must be an object");
  assert(isPlainObject(action.params ?? {}), "action.params must be an object");
  assert(RISKS.includes(action.risk ?? "low"), `unknown risk: ${action.risk}`);
  return {
    ...action,
    id: action.id ?? newId("act"),
    at: action.at ?? Date.now(),
    target: action.target ?? {},
    params: action.params ?? {},
    risk: action.risk ?? "low",
    status: action.status ?? "planned",
  };
}

export function validateCapability(capability) {
  assert(isPlainObject(capability), "capability must be an object");
  assert(typeof capability.name === "string" && /^[a-z][a-z0-9.]{2,80}$/.test(capability.name), "capability.name invalid");
  assert(typeof capability.description === "string" && capability.description, "capability.description required");
  assert(RISKS.includes(capability.risk ?? "low"), `unknown risk: ${capability.risk}`);
  assert(typeof capability.requiresConsent === "boolean" || capability.requiresConsent === undefined, "requiresConsent must be boolean");
  return {
    ...capability,
    params: capability.params ?? {},
    risk: capability.risk ?? "low",
    requiresConsent: capability.requiresConsent ?? (capability.risk !== "low"),
  };
}

export function validateConsent(consent) {
  assert(isPlainObject(consent), "consent must be an object");
  assert(typeof consent.characterId === "string" && consent.characterId, "consent.characterId required");
  assert(typeof consent.scope === "string" && consent.scope, "consent.scope required");
  assert(Array.isArray(consent.actions) && consent.actions.length > 0, "consent.actions required");
  assert(RISKS.includes(consent.riskMax ?? "low"), `unknown riskMax: ${consent.riskMax}`);
  return {
    ...consent,
    id: consent.id ?? newId("consent"),
    at: consent.at ?? Date.now(),
    riskMax: consent.riskMax ?? "low",
    grantedBy: consent.grantedBy ?? "owner",
    revoked: Boolean(consent.revoked),
    expiresAt: consent.expiresAt ?? null,
  };
}

export function validatePluginManifest(manifest) {
  assert(isPlainObject(manifest), "manifest must be an object");
  const id = normalizeId(manifest.id);
  assert(PLUGIN_TYPES.has(manifest.type), `unknown plugin.type: ${manifest.type}`);
  assert(typeof manifest.name === "string" && manifest.name, "plugin.name required");
  assert(typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version), "plugin.version semver required");
  assert(Number.isInteger(manifest.apiVersion) && manifest.apiVersion >= 1, "plugin.apiVersion required");
  assert(Array.isArray(manifest.permissions ?? []), "plugin.permissions must be array");
  assert(Array.isArray(manifest.capabilities ?? []), "plugin.capabilities must be array");
  assert(typeof manifest.entry === "string" && manifest.entry, "plugin.entry required");
  assert(RISKS.includes(manifest.risk ?? "low"), `unknown plugin.risk: ${manifest.risk}`);
  return {
    ...manifest,
    id,
    permissions: manifest.permissions ?? [],
    capabilities: manifest.capabilities ?? [],
    risk: manifest.risk ?? "low",
  };
}
