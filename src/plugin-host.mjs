import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPlugins } from "./plugin-manifest.mjs";
import { IS_ANDROID } from "./edition.mjs";

const WORKER = fileURLToPath(new URL("./plugin-worker.mjs", import.meta.url));

/**
 * Minimal plugin host: one child process per enabled plugin.
 * v0 permissions: events.read / messages.send / storage.
 * It is process isolation + host-side filtering, not a perfect sandbox.
 */
export class PluginHost {
  constructor({ pluginsDir, dataDir, capabilities, log = console.log }) {
    this.pluginsDir = pluginsDir;
    this.dataDir = dataDir;
    this.capabilities = capabilities;
    this.log = log;
    this.plugins = new Map();
    this.granted = new Map();
    this.closed = false;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let stored = {};
    try {
      stored = JSON.parse(await fs.readFile(path.join(this.dataDir, "permissions.json"), "utf8"));
    } catch {
      stored = {};
    }
    const found = await scanPlugins(this.pluginsDir);
    for (const item of found) {
      if (!item.manifest) {
        this.log(`[plugin] skip ${item.dir}: ${item.error}`);
        continue;
      }
      const manifestPermissions = [...item.manifest.permissions];
      const saved = Array.isArray(stored[item.manifest.id]) ? stored[item.manifest.id] : manifestPermissions;
      const granted = saved.filter((permission) => manifestPermissions.includes(permission));
      this.granted.set(item.manifest.id, new Set(granted));
      this.plugins.set(item.manifest.id, {
        manifest: item.manifest,
        dir: item.dir,
        child: null,
        enabled: false,
        status: "stopped",
        error: null,
        pending: null,
        tail: Promise.resolve(),
        storage: null,
      });
    }
    return this;
  }

  hasPermission(plugin, permission) {
    const granted = this.granted.get(plugin.manifest.id);
    return Boolean(granted?.has(permission));
  }

  async savePermissions() {
    const data = {};
    for (const [id, set] of this.granted) data[id] = [...set];
    const file = path.join(this.dataDir, "permissions.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }

  getPermissions(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    const granted = [...(this.granted.get(id) ?? new Set())];
    return { id, manifest: [...plugin.manifest.permissions], granted };
  }

  async setPermissions(id, permissions) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false, error: `unknown plugin: ${id}` };
    if (!Array.isArray(permissions)) return { ok: false, error: "permissions array required" };
    const allowed = new Set(plugin.manifest.permissions);
    const next = [...new Set(permissions.map(String))].filter((permission) => allowed.has(permission));
    this.granted.set(id, new Set(next));
    await this.savePermissions();
    return { ok: true, permissions: this.getPermissions(id) };
  }

  list() {
    return [...this.plugins.values()].map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      type: plugin.manifest.type,
      risk: plugin.manifest.risk,
      permissions: plugin.manifest.permissions,
      granted: [...(this.granted.get(plugin.manifest.id) ?? new Set())],
      capabilities: plugin.manifest.capabilities,
      enabled: plugin.enabled,
      status: plugin.status,
      error: plugin.error,
    }));
  }

  async enable(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false, error: `unknown plugin: ${id}` };
    if (IS_ANDROID) {
      plugin.status = "unsupported";
      plugin.error = "Android 独立包暂不支持代码插件：nodejs-mobile 不能 fork 子进程。桌面版可用。";
      return { ok: false, error: plugin.error, status: "unsupported", platform: "android" };
    }
    if (plugin.enabled) return { ok: true, plugin: this.describe(plugin) };
    const config = {
      id: plugin.manifest.id,
      dir: plugin.dir,
      entry: plugin.manifest.entry,
      permissions: [...(this.granted.get(plugin.manifest.id) ?? new Set())],
    };
    plugin.child = fork(WORKER, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, VRLINK_PLUGIN_CONFIG: JSON.stringify(config) },
      windowsHide: true,
    });
    plugin.enabled = true;
    plugin.status = "starting";
    plugin.error = null;
    plugin.child.stdout?.on("data", (chunk) => this.log(`[plugin:${id}] ${String(chunk).trim()}`));
    plugin.child.stderr?.on("data", (chunk) => this.log(`[plugin:${id}] ${String(chunk).trim()}`));
    plugin.child.on("message", (message) => this.onMessage(plugin, message));
    plugin.child.on("exit", (code) => {
      if (!plugin.enabled) return;
      plugin.status = "crashed";
      plugin.error = `exited with ${code}`;
      plugin.child = null;
      plugin.pending?.reject?.(new Error(plugin.error));
      plugin.pending = null;
    });

    try {
      await waitReady(plugin, 5000);
      plugin.status = "running";
      return { ok: true, plugin: this.describe(plugin) };
    } catch (error) {
      plugin.error = String(error?.message ?? error);
      plugin.status = "error";
      this.kill(plugin);
      return { ok: false, error: plugin.error };
    }
  }

  async disable(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false, error: `unknown plugin: ${id}` };
    plugin.enabled = false;
    plugin.status = "stopped";
    if (plugin.child) {
      try {
        plugin.child.send({ type: "shutdown" });
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      this.kill(plugin);
    }
    return { ok: true };
  }

  async dispatch(event) {
    if (this.closed) return;
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled || !this.hasPermission(plugin, "events.read")) continue;
      plugin.tail = plugin.tail.then(() => this.sendEvent(plugin, event)).catch((error) => {
        plugin.error = String(error?.message ?? error);
      });
    }
  }

  async sendEvent(plugin, event) {
    if (!plugin.child || plugin.status !== "running") return;
    const seq = (plugin.seq = (plugin.seq ?? 0) + 1);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (plugin.pending?.seq !== seq) return;
        plugin.pending = null;
        reject(new Error(`event timeout`));
      }, 3000);
      plugin.pending = { seq, resolve, reject, timer };
    });
    plugin.child.send({ type: "event", name: event.type, payload: event, seq });
    await done;
  }

  async onMessage(plugin, message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      plugin.pendingReady?.resolve?.();
      return;
    }
    if (message.type === "log") {
      this.log(`[plugin:${plugin.manifest.id}] ${message.level}: ${message.message}`);
      return;
    }
    if (message.type === "fatal") {
      plugin.error = String(message.error ?? "fatal");
      plugin.pendingReady?.reject?.(new Error(plugin.error));
      return;
    }
    if (message.type === "send") {
      if (!this.hasPermission(plugin, "messages.send")) {
        this.log(`[plugin:${plugin.manifest.id}] send denied (no messages.send)`);
        return;
      }
      const payload = message.payload ?? {};
      const characterId = String(payload.characterId ?? "").trim();
      const text = String(payload.text ?? "").trim();
      if (!characterId || !text) {
        this.log(`[plugin:${plugin.manifest.id}] send ignored (characterId/text missing)`);
        return;
      }
      try {
        await this.capabilities.invoke({
          characterId,
          name: "message.send",
          params: { text, target: payload.target ?? { body: "desktop", thread: "main" } },
          reason: `plugin:${plugin.manifest.id}`,
        });
      } catch (error) {
        this.log(`[plugin:${plugin.manifest.id}] send failed: ${String(error?.message ?? error)}`);
      }
      return;
    }
    if (message.type === "storage.request") {
      await this.handleStorage(plugin, message);
      return;
    }
    if (message.type === "storage.set") {
      if (!this.hasPermission(plugin, "storage")) return;
      const store = await this.loadStorage(plugin);
      store[String(message.key)] = message.value;
      await this.saveStorage(plugin, store);
      return;
    }
    if (message.type === "event-done") {
      const pending = plugin.pending;
      if (!pending || pending.seq !== message.seq) return;
      clearTimeout(pending.timer);
      plugin.pending = null;
      if (message.ok) pending.resolve();
      else pending.reject(new Error(message.error ?? "plugin event failed"));
    }
  }

  async handleStorage(plugin, message) {
    if (!this.hasPermission(plugin, "storage")) {
      plugin.child?.send({ type: "storage.result", id: message.id, ok: false, error: "no storage permission" });
      return;
    }
    const store = await this.loadStorage(plugin);
    if (message.op === "get") {
      plugin.child?.send({ type: "storage.result", id: message.id, ok: true, value: store[message.key] ?? null });
      return;
    }
    if (message.op === "all") {
      plugin.child?.send({ type: "storage.result", id: message.id, ok: true, value: store });
      return;
    }
    plugin.child?.send({ type: "storage.result", id: message.id, ok: false, error: "unknown op" });
  }

  async loadStorage(plugin) {
    if (plugin.storage) return plugin.storage;
    const file = this.storageFile(plugin);
    try {
      plugin.storage = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      plugin.storage = {};
    }
    return plugin.storage;
  }

  async saveStorage(plugin, value) {
    const file = this.storageFile(plugin);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  storageFile(plugin) {
    return path.join(this.dataDir, plugin.manifest.id, "storage.json");
  }

  async disableAll() {
    const ids = [...this.plugins.values()].filter((plugin) => plugin.enabled).map((plugin) => plugin.manifest.id);
    for (const id of ids) await this.disable(id);
    return { ok: true, disabled: ids };
  }

  async exportStorage(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    return this.loadStorage(plugin);
  }

  async purgeStorage(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false, error: `unknown plugin: ${id}` };
    plugin.storage = null;
    try {
      await fs.rm(this.storageFile(plugin), { force: true });
    } catch {
      /* ignore */
    }
    return { ok: true };
  }

  describe(plugin) {
    return this.list().find((item) => item.id === plugin.manifest.id);
  }

  kill(plugin) {
    try {
      plugin.child?.kill();
    } catch {
      /* ignore */
    }
    plugin.child = null;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.plugins.keys()].map((id) => this.disable(id)));
  }
}

function waitReady(plugin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("plugin ready timeout")), timeoutMs);
    plugin.pendingReady = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
  });
}
