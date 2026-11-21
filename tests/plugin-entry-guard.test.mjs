import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPluginManifest, scanPlugins } from "../src/plugin-manifest.mjs";

async function makePlugin(root, id, entry, files = {}) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id,
      type: "code",
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entry,
      permissions: ["events.read"],
      risk: "low",
    }),
    "utf8",
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return dir;
}

test("plugin entry: 目录内的正常入口可以加载", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-entry-"));
  const dir = await makePlugin(root, "ok-plugin", "index.mjs", { "index.mjs": "export default {};" });
  const found = await readPluginManifest(dir);
  assert.equal(found.manifest.id, "ok-plugin");
  await fs.rm(root, { recursive: true, force: true });
});

test("plugin entry: ../ 越界入口被拒绝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-entry-"));
  const dir = await makePlugin(root, "evil-plugin", "../../escape.mjs", {});
  await assert.rejects(() => readPluginManifest(dir), /entry must stay inside plugin dir/);
  await fs.rm(root, { recursive: true, force: true });
});

test("plugin entry: 绝对路径入口被拒绝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-entry-"));
  const outside = path.join(root, "outside.mjs");
  await fs.writeFile(outside, "export default {};", "utf8");
  const dir = await makePlugin(root, "abs-plugin", outside, {});
  await assert.rejects(() => readPluginManifest(dir), /entry must stay inside plugin dir/);
  await fs.rm(root, { recursive: true, force: true });
});

test("plugin entry: 入口文件不存在时报错", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-entry-"));
  const dir = await makePlugin(root, "missing-plugin", "nope.mjs", {});
  await assert.rejects(() => readPluginManifest(dir), /entry not found/);
  await fs.rm(root, { recursive: true, force: true });
});

test("plugin entry: scanPlugins 把越界插件标成错误而不是加载", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-plugin-entry-"));
  await makePlugin(root, "good-one", "index.mjs", { "index.mjs": "export default {};" });
  await makePlugin(root, "bad-one", "../escape.mjs", {});
  const list = await scanPlugins(root);
  const bad = list.find((item) => item.dir.endsWith("bad-one"));
  const good = list.find((item) => item.dir.endsWith("good-one"));
  assert.ok(bad?.error, "越界插件应带 error");
  assert.equal(bad.manifest, null);
  assert.equal(good?.manifest?.id, "good-one");
  await fs.rm(root, { recursive: true, force: true });
});
