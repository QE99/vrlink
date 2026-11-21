// Virtual home for the first slice: same capability/risk/consent shape as a real adapter.
// Later Home Assistant/MQTT adapters can replace this without touching the core.
//
// IMPORTANT: the default instance is EMPTY. A fresh install must not pretend the
// user owns a living-room curtain, a door lock, etc. The four demo devices below
// are only seeded when a test or an explicit demo mode passes `seedDemo: true`.

const DEMO_DEVICES = [
  {
    id: "living_room_curtain",
    name: "客厅窗帘",
    room: "客厅",
    type: "curtain",
    risk: "low",
    capabilities: [
      { name: "open", label: "打开", risk: "low" },
      { name: "close", label: "关闭", risk: "low" },
      { name: "set_position", label: "开到百分比", risk: "low", params: { percent: "number" } },
    ],
    state: { position: 0 },
  },
  {
    id: "living_room_light",
    name: "客厅灯",
    room: "客厅",
    type: "light",
    risk: "low",
    capabilities: [
      { name: "on", label: "开灯", risk: "low" },
      { name: "off", label: "关灯", risk: "low" },
      { name: "set_brightness", label: "亮度", risk: "low", params: { percent: "number" } },
    ],
    state: { on: false, brightness: 60 },
  },
  {
    id: "front_door_lock",
    name: "大门锁",
    room: "玄关",
    type: "lock",
    risk: "high",
    capabilities: [
      { name: "lock", label: "上锁", risk: "high" },
      { name: "unlock", label: "开锁", risk: "high" },
    ],
    state: { locked: true },
  },
  {
    id: "bedroom_thermostat",
    name: "卧室空调",
    room: "卧室",
    type: "thermostat",
    risk: "medium",
    capabilities: [
      { name: "set_temperature", label: "设温度", risk: "medium", params: { celsius: "number" } },
    ],
    state: { target: 24, current: 26 },
  },
];

export class VirtualHome {
  constructor({ seedDemo = false } = {}) {
    this.devices = new Map(seedDemo ? DEMO_DEVICES.map((device) => [device.id, structuredClone(device)]) : []);
  }

  async init() {
    return this;
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

  command(deviceId, command, args = {}) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`unknown device: ${deviceId}`);
    const capability = device.capabilities.find((item) => item.name === command);
    if (!capability) throw new Error(`device ${deviceId} does not support ${command}`);

    switch (`${device.type}:${command}`) {
      case "curtain:open":
        device.state.position = 100;
        break;
      case "curtain:close":
        device.state.position = 0;
        break;
      case "curtain:set_position":
        device.state.position = clamp(args.percent, 0, 100, 0);
        break;
      case "light:on":
        device.state.on = true;
        break;
      case "light:off":
        device.state.on = false;
        break;
      case "light:set_brightness":
        device.state.brightness = clamp(args.percent, 0, 100, 60);
        break;
      case "lock:lock":
        device.state.locked = true;
        break;
      case "lock:unlock":
        device.state.locked = false;
        break;
      case "thermostat:set_temperature":
        device.state.target = clamp(args.celsius, 10, 32, 24);
        break;
      default:
        throw new Error(`unsupported command: ${device.type}:${command}`);
    }

    return { ok: true, device: publicDevice(device), at: Date.now() };
  }
}

function publicDevice(device) {
  return structuredClone(device);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
