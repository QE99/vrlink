// Home Assistant adapter: discovers entities over REST and maps them to VRlink devices.
// Token is passed by the host from env; never stored in character data.
export class HomeAssistantAdapter {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error("HomeAssistantAdapter: baseUrl required");
    if (!token) throw new Error("HomeAssistantAdapter: token required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.devices = new Map();
  }

  async init() {
    await this.refresh();
    return this;
  }

  async refresh() {
    const states = await this.request("/api/states");
    const next = new Map();
    for (const state of Array.isArray(states) ? states : []) {
      const device = mapEntity(state);
      if (device) next.set(device.id, device);
    }
    this.devices = next;
    return this.list();
  }

  list() {
    return [...this.devices.values()].map(publicDevice);
  }

  get(id) {
    const device = this.devices.get(id);
    return device ? publicDevice(device) : null;
  }

  riskFor(deviceId, command) {
    const device = this.devices.get(deviceId);
    if (!device) return "forbidden";
    const capability = device.capabilities.find((item) => item.name === command);
    if (!capability) return "forbidden";
    return capability.risk ?? device.risk ?? "high";
  }

  async command(deviceId, command, args = {}) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`unknown device: ${deviceId}`);
    const capability = device.capabilities.find((item) => item.name === command);
    if (!capability) throw new Error(`device ${deviceId} does not support ${command}`);
    const service = serviceFor(device, command, args);
    const result = await this.request(`/api/services/${service.domain}/${service.name}`, {
      method: "POST",
      body: JSON.stringify({ entity_id: device.id, ...service.data }),
    });
    const updated = findState(result, device.id);
    if (updated) {
      const mapped = mapEntity(updated);
      if (mapped) device.state = mapped.state;
    } else {
      try {
        const one = await this.request(`/api/states/${encodeURIComponent(device.id)}`);
        const mapped = mapEntity(one);
        if (mapped) device.state = mapped.state;
      } catch {
        // cache update is best-effort
      }
    }
    return { ok: true, device: publicDevice(device), at: Date.now() };
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Home Assistant ${response.status}: ${text.slice(0, 300)}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

function mapEntity(state) {
  const domain = String(state.entity_id ?? "").split(".")[0];
  const attributes = state.attributes ?? {};
  const name = String(attributes.friendly_name ?? state.entity_id ?? "unknown");
  const room = String(attributes.area ?? attributes.room ?? "");
  const common = { id: state.entity_id, name, room, type: domain, entityId: state.entity_id };

  if (domain === "light") {
    return {
      ...common,
      risk: "low",
      capabilities: [
        { name: "turn_on", label: "开灯", risk: "low" },
        { name: "turn_off", label: "关灯", risk: "low" },
        { name: "set_brightness", label: "亮度", risk: "low", params: { percent: "number" } },
      ],
      state: { on: state.state === "on", brightness: Math.round((Number(attributes.brightness ?? 0) / 255) * 100) },
    };
  }
  if (domain === "cover") {
    return {
      ...common,
      risk: "low",
      capabilities: [
        { name: "open_cover", label: "打开", risk: "low" },
        { name: "close_cover", label: "关闭", risk: "low" },
        { name: "set_cover_position", label: "开到百分比", risk: "low", params: { percent: "number" } },
      ],
      state: { position: Number(attributes.current_position ?? 0), moving: state.state === "opening" || state.state === "closing" },
    };
  }
  if (domain === "lock") {
    return {
      ...common,
      risk: "high",
      capabilities: [
        { name: "lock", label: "上锁", risk: "high" },
        { name: "unlock", label: "开锁", risk: "high" },
      ],
      state: { locked: state.state === "locked" },
    };
  }
  if (domain === "climate") {
    return {
      ...common,
      risk: "medium",
      capabilities: [
        { name: "set_temperature", label: "设温度", risk: "medium", params: { celsius: "number" } },
      ],
      state: {
        current: Number(attributes.current_temperature ?? 0),
        target: Number(attributes.temperature ?? 0),
        mode: state.state,
      },
    };
  }
  if (domain === "switch") {
    return {
      ...common,
      risk: "low",
      capabilities: [
        { name: "turn_on", label: "打开", risk: "low" },
        { name: "turn_off", label: "关闭", risk: "low" },
      ],
      state: { on: state.state === "on" },
    };
  }
  if (domain === "sensor" || domain === "binary_sensor") {
    return {
      ...common,
      risk: "low",
      capabilities: [],
      state: { value: state.state, unit: attributes.unit_of_measurement ?? "" },
    };
  }
  return null;
}

function serviceFor(device, command, args) {
  const entityId = device.id;
  if (device.type === "light") {
    if (command === "turn_on") return { domain: "light", name: "turn_on", data: { entity_id: entityId } };
    if (command === "turn_off") return { domain: "light", name: "turn_off", data: { entity_id: entityId } };
    if (command === "set_brightness") {
      return { domain: "light", name: "turn_on", data: { entity_id: entityId, brightness_pct: clamp(args.percent, 0, 100, 60) } };
    }
  }
  if (device.type === "cover") {
    if (command === "open_cover") return { domain: "cover", name: "open_cover", data: { entity_id: entityId } };
    if (command === "close_cover") return { domain: "cover", name: "close_cover", data: { entity_id: entityId } };
    if (command === "set_cover_position") {
      return { domain: "cover", name: "set_cover_position", data: { entity_id: entityId, position: clamp(args.percent, 0, 100, 0) } };
    }
  }
  if (device.type === "lock") {
    if (command === "lock") return { domain: "lock", name: "lock", data: { entity_id: entityId } };
    if (command === "unlock") return { domain: "lock", name: "unlock", data: { entity_id: entityId } };
  }
  if (device.type === "climate" && command === "set_temperature") {
    return { domain: "climate", name: "set_temperature", data: { entity_id: entityId, temperature: clamp(args.celsius, 10, 32, 24) } };
  }
  if (device.type === "switch") {
    if (command === "turn_on") return { domain: "switch", name: "turn_on", data: { entity_id: entityId } };
    if (command === "turn_off") return { domain: "switch", name: "turn_off", data: { entity_id: entityId } };
  }
  throw new Error(`unsupported command: ${device.type}:${command}`);
}

function findState(result, entityId) {
  if (!Array.isArray(result)) return null;
  return result.find((item) => item?.entity_id === entityId) ?? null;
}

function publicDevice(device) {
  return structuredClone(device);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
