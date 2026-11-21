import { RISKS, validateCapability } from "./contracts.mjs";
import { VirtualHome } from "./devices.mjs";

export class ConsentRequiredError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ConsentRequiredError";
    this.code = "CONSENT_REQUIRED";
    this.detail = detail;
  }
}

export class CapabilityBus {
  constructor({ consent, audit }) {
    this.consent = consent;
    this.audit = audit;
    this.map = new Map();
  }

  register(capability, handler) {
    const cap = validateCapability(capability);
    if (typeof handler !== "function") throw new Error(`capability ${cap.name} needs a handler`);
    this.map.set(cap.name, { cap, handler });
    return cap;
  }

  list() {
    return [...this.map.values()].map(({ cap }) => ({
      name: cap.name,
      description: cap.description,
      params: cap.params,
      risk: cap.risk,
      requiresConsent: cap.requiresConsent,
    }));
  }

  async invoke({ characterId, name, params = {}, reason = "", approvalToken = null }) {
    const entry = this.map.get(name);
    if (!entry) throw new Error(`unknown capability: ${name}`);
    const resolvedRisk =
      typeof entry.cap.resolveRisk === "function" ? entry.cap.resolveRisk(params) : entry.cap.risk;
    if (!RISKS.includes(resolvedRisk)) throw new Error(`capability ${name} resolved invalid risk: ${resolvedRisk}`);
    if (resolvedRisk === "forbidden") {
      throw new ConsentRequiredError(`capability ${name} is forbidden`, { name, risk: "forbidden" });
    }

    const decision = this.consent.check({ characterId, action: name, risk: resolvedRisk });
    if (!decision.ok) {
      const approved =
        decision.requiresApproval && approvalToken
          ? await this.consent.consume(approvalToken, { characterId, action: name })
          : false;
      if (!approved) {
        throw new ConsentRequiredError(`capability ${name} needs consent`, {
          name,
          risk: resolvedRisk,
          requiresApproval: Boolean(decision.requiresApproval),
          grantId: decision.grantId ?? null,
        });
      }
    }

    try {
      const result = await entry.handler({ characterId, params, reason });
      await this.audit.append(characterId, {
        kind: "capability",
        action: name,
        risk: resolvedRisk,
        reason,
        params,
        result: { ok: true, summary: summarize(result) },
      });
      return result;
    } catch (error) {
      await this.audit.append(characterId, {
        kind: "capability",
        action: name,
        risk: resolvedRisk,
        reason,
        params,
        result: { ok: false, error: String(error?.message ?? error) },
      });
      throw error;
    }
  }
}

function summarize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "object") return Object.keys(value).slice(0, 10);
  return value;
}

export function registerBuiltins({ bus, store, eventLog, home = new VirtualHome() }) {
  bus.register(
    {
      name: "message.send",
      description: "给某个角色的聊天/渠道发一条消息（写入事件流）",
      params: { text: "string", target: "object?" },
      risk: "low",
      requiresConsent: false,
    },
    async ({ characterId, params }) => {
      const text = String(params.text ?? "").trim();
      if (!text) throw new Error("message.send.text required");
      const target = params.target ?? {};
      const event = await eventLog.append(characterId, {
        type: "message.sent",
        source: {
          body: String(target.body ?? "desktop"),
          thread: String(target.thread ?? "main"),
          actor: null,
        },
        visibility: target.visibility ?? "private",
        content: { text },
      });
      return { ok: true, event };
    },
  );

  bus.register(
    {
      name: "memory.add",
      description: "给某个角色加一条长期记忆",
      params: { text: "string", visibility: "string?" },
      risk: "low",
      requiresConsent: false,
    },
    async ({ characterId, params }) => {
      const row = await store.appendMemory(characterId, {
        text: String(params.text ?? ""),
        source: String(params.source ?? "capability:memory.add"),
        visibility: params.visibility ?? "private",
      });
      return { ok: true, memory: row };
    },
  );

  bus.register(
    {
      name: "time.now",
      description: "读当前时间",
      params: {},
      risk: "low",
      requiresConsent: false,
    },
    async () => ({ ok: true, now: Date.now(), iso: new Date().toISOString() }),
  );

  bus.register(
    {
      name: "device.command",
      description: "控制现实设备（当前为虚拟设备；风险按设备/命令动态计算）",
      params: { deviceId: "string", command: "string", args: "object?" },
      risk: "low",
      requiresConsent: true,
      resolveRisk: ({ deviceId, command }) => home.riskFor(deviceId, command),
    },
    async ({ params }) => home.command(String(params.deviceId ?? ""), String(params.command ?? ""), params.args ?? {}),
  );

  bus.register(
    {
      name: "device.list",
      description: "列出设备与状态",
      params: {},
      risk: "low",
      requiresConsent: false,
    },
    async () => ({ ok: true, devices: home.list() }),
  );
}
