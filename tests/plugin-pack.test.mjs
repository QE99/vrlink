// plugin-pack 打包/校验工具测试。
// 只写临时目录（os.tmpdir()），不碰仓库的 data。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { packPlugin, createZip, isSafeRelativePath, PluginPackError, PACK_LIMITS } from "../tools/plugin-pack.mjs";
import { readZipBuffer } from "../src/import/zip.mjs";
import { PLUGIN_PERMISSIONS } from "../src/plugin-manifest.mjs";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOOL = path.join(ROOT, "tools", "plugin-pack.mjs");
const TEMPLATE_DIR = path.join(ROOT, "plugins", "_template");

const BASE_MANIFEST = {
  id: "test-plugin",
  type: "code",
  apiVersion: 1,
  version: "0.1.0",
  name: "测试插件",
  entry: "index.mjs",
  permissions: ["events.read"],
  capabilities: [],
  risk: "low",
  license: "MIT",
};

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-pack-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makePlugin(root, { manifest = {}, files = {}, skipEntry = false } = {}) {
  const dir = path.join(root, "plugin");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    `${JSON.stringify({ ...BASE_MANIFEST, ...manifest }, null, 2)}\n`,
    "utf8",
  );
  if (!skipEntry) {
    const entry = files["index.mjs"] ?? "export default function activate(api) { api.log('info', 'hi'); }\n";
    await fs.writeFile(path.join(dir, "index.mjs"), entry);
  }
  for (const [name, content] of Object.entries(files)) {
    if (name === "index.mjs") continue;
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

test("plugin-pack: 合法插件打包成功，SHA256 与 zip 内容可回读", async (t) => {
  const root = await tempDir(t);
  const dir = await makePlugin(root, {
    files: {
      "README.md": "# 测试插件\n",
      "assets/a.txt": "hello vrlink",
    },
  });
  const out = path.join(root, "dist", "test-plugin-0.1.0.zip");

  const result = await packPlugin({ dir, out });
  assert.equal(result.ok, true);
  assert.equal(result.id, "test-plugin");
  assert.equal(result.version, "0.1.0");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.size > 0);

  const buffer = await fs.readFile(out);
  assert.equal(buffer.length, result.size);
  assert.equal(crypto.createHash("sha256").update(buffer).digest("hex"), result.sha256);

  const files = readZipBuffer(buffer);
  assert.deepEqual([...files.keys()].sort(), ["README.md", "assets/a.txt", "index.mjs", "plugin.json"]);
  assert.equal(JSON.parse(files.get("plugin.json").toString("utf8")).id, "test-plugin");
  assert.equal(files.get("assets/a.txt").toString("utf8"), "hello vrlink");

  // 确定性：同样内容再打一次，SHA256 一致（固定 ZIP 时间戳，方便发布时核对）。
  const again = await packPlugin({ dir, out: path.join(root, "dist", "again.zip") });
  assert.equal(again.sha256, result.sha256);
});

test("plugin-pack: plugins/_template 可以直接打包", async (t) => {
  const root = await tempDir(t);
  const out = path.join(root, "template-0.1.0.zip");
  const result = await packPlugin({ dir: TEMPLATE_DIR, out });
  assert.equal(result.id, "template");
  for (const name of ["plugin.json", "index.mjs", "README.md"]) {
    assert.ok(result.files.includes(name), `缺少 ${name}`);
  }
  const files = readZipBuffer(await fs.readFile(out));
  const manifest = JSON.parse(files.get("plugin.json").toString("utf8"));
  assert.deepEqual(manifest.permissions, ["events.read", "messages.send", "storage"]);
});

test("plugin-pack: 缺必填字段 / 非法 id 给出可读原因", async (t) => {
  const root = await tempDir(t);

  const missingName = await makePlugin(path.join(root, "missing-name"), { manifest: { name: undefined } });
  await assert.rejects(
    () => packPlugin({ dir: missingName, out: path.join(root, "x.zip") }),
    (error) => {
      assert.ok(error instanceof PluginPackError);
      assert.equal(error.code, "MANIFEST_INVALID");
      assert.match(error.message, /plugin\.name required/);
      return true;
    },
  );

  const badId = await makePlugin(path.join(root, "bad-id"), { manifest: { id: "Bad Id!" } });
  await assert.rejects(
    () => packPlugin({ dir: badId, out: path.join(root, "y.zip") }),
    (error) => {
      assert.equal(error.code, "MANIFEST_INVALID");
      assert.match(error.message, /id must match/);
      return true;
    },
  );
});

test("plugin-pack: 未知权限被拒绝并列出白名单", async (t) => {
  const root = await tempDir(t);
  const dir = await makePlugin(root, {
    manifest: { permissions: ["events.read", "root.everything"] },
  });
  await assert.rejects(
    () => packPlugin({ dir, out: path.join(root, "x.zip") }),
    (error) => {
      assert.ok(error instanceof PluginPackError);
      assert.equal(error.code, "PERMISSION_UNKNOWN");
      assert.match(error.message, /root\.everything/);
      assert.match(error.message, /network\.internet/);
      return true;
    },
  );
});

test("plugin-pack: 拒绝路径穿越的 entry，isSafeRelativePath 覆盖绝对/盘符/..", async (t) => {
  for (const entry of ["../escape.mjs", "a/../../escape.mjs", "/abs/index.mjs", "C:/windows/index.mjs", "..\\evil.mjs"]) {
    assert.equal(isSafeRelativePath(entry), false, `应当拒绝 ${entry}`);
  }
  assert.equal(isSafeRelativePath("index.mjs"), true);
  assert.equal(isSafeRelativePath("src/lib/index.mjs"), true);

  const root = await tempDir(t);
  const dir = await makePlugin(root, { manifest: { entry: "../escape.mjs" } });
  await assert.rejects(
    () => packPlugin({ dir, out: path.join(root, "x.zip") }),
    (error) => {
      assert.equal(error.code, "UNSAFE_PATH");
      assert.match(error.message, /entry/);
      return true;
    },
  );
});

test("plugin-pack: 拒绝可执行文件（扩展名与 MZ/ELF/shebang 魔数）", async (t) => {
  const root = await tempDir(t);
  const mz = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]);

  const byExtension = await makePlugin(path.join(root, "by-ext"), {
    files: { "tools/run.exe": mz },
  });
  await assert.rejects(
    () => packPlugin({ dir: byExtension, out: path.join(root, "a.zip") }),
    (error) => {
      assert.equal(error.code, "EXECUTABLE_FILE");
      assert.match(error.message, /run\.exe/);
      return true;
    },
  );

  const byMagic = await makePlugin(path.join(root, "by-magic"), {
    files: { "assets/payload": mz },
  });
  await assert.rejects(
    () => packPlugin({ dir: byMagic, out: path.join(root, "b.zip") }),
    (error) => {
      assert.equal(error.code, "EXECUTABLE_FILE");
      assert.match(error.message, /MZ 头/);
      return true;
    },
  );

  const byShebang = await makePlugin(path.join(root, "by-shebang"), {
    files: { "scripts/run.mjs": "#!/usr/bin/env node\nconsole.log('x');\n" },
  });
  await assert.rejects(
    () => packPlugin({ dir: byShebang, out: path.join(root, "c.zip") }),
    (error) => {
      assert.equal(error.code, "EXECUTABLE_FILE");
      assert.match(error.message, /shebang/);
      return true;
    },
  );
});

test("zip writer: createZip → readZipBuffer 往返一致，拒绝不安全条目", () => {
  const zip = createZip([
    { name: "plugin.json", data: JSON.stringify({ id: "demo" }) },
    { name: "dir/b.txt", data: "第二行\n".repeat(50) },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ]);
  const files = readZipBuffer(zip);
  assert.equal(JSON.parse(files.get("plugin.json").toString("utf8")).id, "demo");
  assert.equal(files.get("dir/b.txt").toString("utf8"), "第二行\n".repeat(50));
  assert.equal(files.get("empty.txt").length, 0);

  assert.throws(() => createZip([{ name: "../evil.txt", data: "x" }]), /不安全/);
  assert.throws(() => createZip([{ name: "/abs.txt", data: "x" }]), /不安全/);
  assert.throws(() => createZip([]), PluginPackError);
});

test("plugin-pack CLI: 成功打印 SHA256，校验失败退出码 2 且 stderr 可读", async (t) => {
  const root = await tempDir(t);
  const dir = await makePlugin(root, {});
  const out = path.join(root, "cli.zip");

  const ok = await execFileAsync(process.execPath, [TOOL, dir, "--out", out], { encoding: "utf8" });
  assert.match(ok.stdout, /SHA256: [0-9a-f]{64}/);
  assert.ok((await fs.stat(out)).isFile());

  const badDir = await makePlugin(path.join(root, "bad"), { manifest: { version: "not-semver" } });
  let failure = null;
  try {
    await execFileAsync(process.execPath, [TOOL, badDir, "--out", path.join(root, "bad.zip")], { encoding: "utf8" });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "非法插件应当以非 0 退出");
  assert.equal(failure.code, 2);
  assert.match(String(failure.stderr), /校验失败/);
  assert.match(String(failure.stderr), /plugin\.version/);
});

test("plugin-pack: 白名单与宿主权限表一致（9 个权限）", () => {
  assert.deepEqual(
    [...PLUGIN_PERMISSIONS].sort(),
    [
      "capabilities.invoke",
      "devices.command",
      "events.read",
      "memory.read",
      "memory.write",
      "messages.send",
      "network.internet",
      "network.lan",
      "storage",
    ],
  );
  assert.equal(PACK_LIMITS.maxFiles, 256);
});
