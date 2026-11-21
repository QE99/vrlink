// Minimal plugin worker. Runs in a child process; only talks to the host over IPC.
// API v0: on(event) / log / send / storage. Everything else is denied by the host.
import { pathToFileURL } from "node:url";
import path from "node:path";

const config = JSON.parse(process.env.VRLINK_PLUGIN_CONFIG ?? "{}");
const handlers = [];
const pending = new Map();
let seq = 0;

function post(message) {
  try {
    process.send?.(message);
  } catch {
    /* host gone */
  }
}

function requestStorage(op, data = {}) {
  const id = `st_${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`storage ${op} timeout`));
    }, 3000);
    pending.set(id, { resolve, reject, timer });
    post({ type: "storage.request", id, op, ...data });
  });
}

const api = {
  id: config.id,
  permissions: Object.freeze([...(config.permissions ?? [])]),
  on(type, handler) {
    if (type !== "event") throw new Error(`unsupported subscription: ${type}`);
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  },
  log(level, message) {
    post({ type: "log", level: String(level ?? "info"), message: String(message ?? "") });
  },
  send(payload) {
    post({ type: "send", payload });
  },
  storage: {
    get(key) {
      return requestStorage("get", { key: String(key) });
    },
    all() {
      return requestStorage("all");
    },
    set(key, value) {
      post({ type: "storage.set", key: String(key), value });
    },
  },
};

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "event") {
    try {
      for (const handler of handlers) await handler(message.name, message.payload);
      post({ type: "event-done", seq: message.seq, ok: true });
    } catch (error) {
      post({ type: "event-done", seq: message.seq, ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (message.type === "storage.result") {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (message.ok) item.resolve(message.value);
    else item.reject(new Error(message.error ?? "storage error"));
    return;
  }
  if (message.type === "shutdown") {
    process.exit(0);
  }
});

try {
  const entry = path.resolve(config.dir, config.entry);
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.default !== "function") throw new Error("plugin must export default activate(api)");
  await module.default(api);
  post({ type: "ready" });
} catch (error) {
  post({ type: "fatal", error: String(error?.stack ?? error?.message ?? error) });
  process.exit(1);
}
