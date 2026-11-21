#!/usr/bin/env node
// VRlink v2 插件打包/校验工具（零第三方依赖，只用 Node 自带模块）
//
// 用法：
//   node tools/plugin-pack.mjs <插件目录> [--out <输出.zip>] [--json]
//   node tools/plugin-pack.mjs plugins/_template --out dist/template-0.1.0.zip
//
// 做四件事：
//   1. 校验 plugin.json（必填字段、枚举、权限白名单、entry 路径）
//   2. 校验所有要打包的文件（拒绝 ../ 路径穿越、绝对路径、符号链接、可执行文件）
//   3. 用 node:zlib 写一个最小 ZIP（deflate，无 ZIP64，无加密，确定性输出）
//   4. 打印输出路径、文件数、字节数与 SHA256
//
// 退出码：0 成功；2 校验/用法错误（可读原因）；1 其他错误。
// 这是给“分享插件”用的校验器，不是安装器，也不是安全扫描器。

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import { validatePluginManifest } from "../src/contracts.mjs";
import { PLUGIN_PERMISSIONS } from "../src/plugin-manifest.mjs";

export const PACK_LIMITS = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

// 扩展名黑名单：这些文件不会被插件宿主执行，但出现在插件包里没有正当理由。
const EXECUTABLE_EXTENSIONS = new Map([
  [".exe", "Windows 可执行文件"],
  [".dll", "动态库"],
  [".sys", "内核驱动"],
  [".drv", "驱动"],
  [".scr", "屏保（可执行）"],
  [".com", "DOS 可执行文件"],
  [".msi", "安装包"],
  [".msix", "安装包"],
  [".appx", "安装包"],
  [".bat", "批处理脚本"],
  [".cmd", "批处理脚本"],
  [".ps1", "PowerShell 脚本"],
  [".psm1", "PowerShell 模块"],
  [".vbs", "VBScript"],
  [".vbe", "VBScript"],
  [".wsf", "Windows 脚本"],
  [".wsh", "Windows 脚本"],
  [".hta", "HTML 应用"],
  [".cpl", "控制面板项"],
  [".sh", "Shell 脚本"],
  [".bash", "Shell 脚本"],
  [".zsh", "Shell 脚本"],
  [".fish", "Shell 脚本"],
  [".so", "Linux 动态库"],
  [".dylib", "macOS 动态库"],
  [".node", "Node 原生扩展"],
  [".jar", "Java 包"],
  [".apk", "Android 包"],
  [".pkg", "macOS 安装包"],
  [".dmg", "macOS 磁盘映像"],
  [".deb", "Debian 包"],
  [".rpm", "RPM 包"],
  [".iso", "磁盘映像"],
  [".wasm", "WebAssembly 模块"],
]);

export class PluginPackError extends Error {
  constructor(message, code = "PACK_INVALID") {
    super(message);
    this.name = "PluginPackError";
    this.code = code;
  }
}

/** 相对路径是否安全：不能绝对、不能盘符、不能反斜杠、不能含 . / .. 段。 */
export function isSafeRelativePath(value) {
  const name = String(value ?? "");
  if (!name || name !== name.trim()) return false;
  if (name.includes("\\") || name.includes("\0")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  if (/[\u0000-\u001f]/.test(name)) return false;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return true;
}

export function assertSafeRelativePath(value, label = "路径") {
  const name = String(value ?? "");
  if (!isSafeRelativePath(name)) {
    throw new PluginPackError(
      `${label} 不安全：${JSON.stringify(name)}。必须是插件目录内的相对路径，不能是绝对路径、不能含盘符、反斜杠或 .. 段。`,
      "UNSAFE_PATH",
    );
  }
  return name;
}

/** 统一 entry 写法：允许 \ 和开头的 ./，但最终必须是安全的相对路径。 */
function normalizeEntry(value) {
  let entry = String(value ?? "").trim().replaceAll("\\", "/");
  while (entry.startsWith("./")) entry = entry.slice(2);
  return assertSafeRelativePath(entry, "plugin.json 的 entry");
}

export async function readManifestForPack(dir) {
  const file = path.join(dir, "plugin.json");
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new PluginPackError(`找不到 plugin.json：${file}`, "MANIFEST_MISSING");
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new PluginPackError(`plugin.json 不是合法 JSON：${error.message}`, "MANIFEST_JSON");
  }
  let manifest;
  try {
    manifest = validatePluginManifest(json);
  } catch (error) {
    throw new PluginPackError(`plugin.json 校验失败：${error.message}`, "MANIFEST_INVALID");
  }
  const unknown = manifest.permissions.filter((permission) => !PLUGIN_PERMISSIONS.has(permission));
  if (unknown.length) {
    throw new PluginPackError(
      `未知权限：${unknown.join(", ")}。允许的权限只有：${[...PLUGIN_PERMISSIONS].join(", ")}`,
      "PERMISSION_UNKNOWN",
    );
  }
  const entry = normalizeEntry(manifest.entry);
  return { manifest, entry };
}

function isExecutableExtension(name) {
  const ext = path.extname(name).toLowerCase();
  return EXECUTABLE_EXTENSIONS.get(ext) ?? null;
}

function executableMagicReason(data) {
  if (data.length >= 4) {
    if (data[0] === 0x4d && data[1] === 0x5a) return "Windows PE/可执行文件（MZ 头）";
    if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return "ELF 可执行文件";
    const magic = data.readUInt32BE(0);
    if (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe
    ) {
      return "Mach-O / Java class 可执行文件";
    }
  }
  if (data.length >= 2 && data[0] === 0x23 && data[1] === 0x21) return "带 shebang 的可执行脚本";
  return null;
}

function assertNotExecutable(name, data) {
  const extReason = isExecutableExtension(name);
  if (extReason) {
    throw new PluginPackError(`拒绝打包可执行文件：${name}（${extReason}）`, "EXECUTABLE_FILE");
  }
  const magicReason = executableMagicReason(data);
  if (magicReason) {
    throw new PluginPackError(`拒绝打包可执行文件：${name}（${magicReason}）`, "EXECUTABLE_FILE");
  }
}

async function collectFiles(rootDir, { skipAbsolute = new Set() } = {}) {
  const files = [];
  let total = 0;

  async function walk(current, prefix) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (skipAbsolute.has(path.resolve(full))) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new PluginPackError(`拒绝打包符号链接：${rel}（链接可能指向插件目录之外）`, "SYMLINK");
      }
      if (stat.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!stat.isFile()) {
        throw new PluginPackError(`不支持的文件类型：${rel}`, "NOT_REGULAR_FILE");
      }
      assertSafeRelativePath(rel, `文件路径 ${rel}`);
      if (stat.size > PACK_LIMITS.maxFileBytes) {
        throw new PluginPackError(
          `单个文件过大：${rel} 是 ${stat.size} 字节（上限 ${PACK_LIMITS.maxFileBytes}）`,
          "TOO_LARGE",
        );
      }
      total += stat.size;
      if (total > PACK_LIMITS.maxTotalBytes) {
        throw new PluginPackError(`插件总大小超过上限 ${PACK_LIMITS.maxTotalBytes} 字节`, "TOO_LARGE");
      }
      const data = await fs.readFile(full);
      assertNotExecutable(rel, data);
      files.push({ name: rel, data });
      if (files.length > PACK_LIMITS.maxFiles) {
        throw new PluginPackError(`文件数量超过上限 ${PACK_LIMITS.maxFiles}`, "TOO_MANY_FILES");
      }
    }
  }

  await walk(rootDir, "");
  return files;
}

// ---------------- 最小 ZIP writer ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 固定成 1980-01-01 00:00:00，保证同一份内容打出的 zip 字节完全一致（SHA256 可复现）。
const DOS_TIME = 0;
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;

/**
 * 用 node:zlib 生成一个标准 ZIP Buffer。
 * @param {{name: string, data: Buffer|string}[]} entries
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new PluginPackError("createZip 需要至少一个文件", "EMPTY_PACKAGE");
  }
  if (entries.length > 0xffff) throw new PluginPackError("文件太多，超出 ZIP 格式上限", "TOO_MANY_FILES");

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const seen = new Set();

  for (const item of entries) {
    const name = assertSafeRelativePath(item?.name, `zip 条目 ${item?.name}`);
    if (seen.has(name)) throw new PluginPackError(`zip 里有重复文件：${name}`, "DUPLICATE_FILE");
    seen.add(name);
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? "");
    if (data.length > 0xffffffff) throw new PluginPackError(`文件过大：${name}`, "TOO_LARGE");

    const crc = crc32(data);
    let method = 8;
    let compressed = zlib.deflateRawSync(data, { level: 9 });
    if (compressed.length >= data.length) {
      method = 0;
      compressed = data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 作成版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // EOCD
  end.writeUInt16LE(0, 4); // 本磁盘号
  end.writeUInt16LE(0, 6); // 中央目录起始磁盘
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16); // 中央目录偏移
  end.writeUInt16LE(0, 20); // comment 长度

  return Buffer.concat([...localParts, centralBuffer, end]);
}

// ---------------- 打包主流程 ----------------

export async function packPlugin({ dir, out } = {}) {
  if (!dir) throw new PluginPackError("缺少插件目录参数", "USAGE");
  const sourceDir = path.resolve(dir);
  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    throw new PluginPackError(`插件目录不存在：${sourceDir}`, "DIR_MISSING");
  }
  if (!stat.isDirectory()) throw new PluginPackError(`不是目录：${sourceDir}`, "DIR_MISSING");

  const { manifest, entry } = await readManifestForPack(sourceDir);

  const outputFile = path.resolve(out ?? path.join(process.cwd(), `${manifest.id}-${manifest.version}.zip`));
  const files = await collectFiles(sourceDir, { skipAbsolute: new Set([outputFile]) });
  if (files.length === 0) throw new PluginPackError("插件目录里没有可打包的文件", "EMPTY_PACKAGE");
  if (!files.some((file) => file.name === entry)) {
    throw new PluginPackError(
      `plugin.json 的 entry「${manifest.entry}」不在打包文件里（打包后入口会不存在）`,
      "ENTRY_MISSING",
    );
  }

  const zip = createZip(files);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, zip);
  const sha256 = crypto.createHash("sha256").update(zip).digest("hex");

  return {
    ok: true,
    id: manifest.id,
    version: manifest.version,
    out: outputFile,
    sha256,
    size: zip.length,
    files: files.map((file) => file.name),
    manifest,
  };
}

// ---------------- CLI ----------------

const USAGE = `用法：
  node tools/plugin-pack.mjs <插件目录> [--out <输出.zip>] [--json]

示例：
  node tools/plugin-pack.mjs plugins/_template --out dist/template-0.1.0.zip

退出码：0 成功；2 校验/用法错误；1 其他错误。`;

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }

  let dir = null;
  let out = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--out" || arg === "-o") {
      out = args[index + 1];
      index += 1;
      if (!out) throw new PluginPackError("--out 后面要跟输出文件名", "USAGE");
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("-")) {
      throw new PluginPackError(`未知参数：${arg}`, "USAGE");
    } else if (!dir) {
      dir = arg;
    } else {
      throw new PluginPackError(`多余的位置参数：${arg}`, "USAGE");
    }
  }
  if (!dir) throw new PluginPackError("缺少插件目录参数", "USAGE");

  const result = await packPlugin({ dir, out });
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          id: result.id,
          version: result.version,
          out: result.out,
          sha256: result.sha256,
          size: result.size,
          files: result.files,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`✔ 校验通过：${result.id} ${result.version}（${result.files.length} 个文件）`);
  console.log(`✔ 打包完成：${result.out}`);
  console.log(`  大小：${result.size} 字节`);
  console.log(`SHA256: ${result.sha256}`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isCli = Boolean(invokedFile) && pathToFileURL(invokedFile).href === import.meta.url;

if (isCli) {
  main(process.argv)
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof PluginPackError) {
        console.error(`✖ 打包失败（${error.code}）：${error.message}`);
        process.exitCode = 2;
      } else {
        console.error(`✖ 打包失败：${error?.stack ?? error}`);
        process.exitCode = 1;
      }
    });
}
