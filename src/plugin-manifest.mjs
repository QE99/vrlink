import fs from "node:fs/promises";
import path from "node:path";
import { validatePluginManifest } from "./contracts.mjs";

export const PLUGIN_PERMISSIONS = new Set([
  "events.read",
  "messages.send",
  "memory.read",
  "memory.write",
  "capabilities.invoke",
  "storage",
  "network.lan",
  "network.internet",
  "devices.command",
]);

export async function readPluginManifest(dir) {
  const file = path.join(dir, "plugin.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const manifest = validatePluginManifest(raw);
  for (const permission of manifest.permissions) {
    if (!PLUGIN_PERMISSIONS.has(permission)) {
      throw new Error(`plugin ${manifest.id}: unknown permission ${permission}`);
    }
  }
  // 安全：入口必须留在插件目录内（手动安装的插件也要过这一关）。
  // 先按 resolve 后的路径判一次越界，再用 realpath 判一次防止符号链接逃逸。
  const realDir = await fs.realpath(dir);
  const entryPath = path.resolve(realDir, manifest.entry);
  const relative = path.relative(realDir, entryPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`plugin ${manifest.id}: entry must stay inside plugin dir (got ${manifest.entry})`);
  }
  let realEntry;
  try {
    realEntry = await fs.realpath(entryPath);
  } catch {
    throw new Error(`plugin ${manifest.id}: entry not found: ${manifest.entry}`);
  }
  const relativeReal = path.relative(realDir, realEntry);
  if (!relativeReal || relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
    throw new Error(`plugin ${manifest.id}: entry must stay inside plugin dir (got ${manifest.entry})`);
  }
  const stat = await fs.stat(realEntry);
  if (!stat.isFile()) {
    throw new Error(`plugin ${manifest.id}: entry must be a file: ${manifest.entry}`);
  }
  return { manifest, dir, file };
}

export async function scanPlugins(baseDir) {
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      out.push(await readPluginManifest(path.join(baseDir, entry.name)));
    } catch (error) {
      out.push({
        dir: path.join(baseDir, entry.name),
        error: String(error?.message ?? error),
        manifest: null,
      });
    }
  }
  return out;
}

export function describePermissions(manifest) {
  const map = {
    "events.read": "读取事件",
    "messages.send": "发送消息",
    "memory.read": "读取记忆",
    "memory.write": "写入记忆",
    "capabilities.invoke": "调用其他能力",
    "storage": "使用自己的存储",
    "network.lan": "访问局域网",
    "network.internet": "访问互联网",
    "devices.command": "控制设备",
  };
  return (manifest.permissions ?? []).map((permission) => ({
    permission,
    description: map[permission] ?? permission,
  }));
}
