import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOL = path.join(ROOT, "tools", "release-manifest.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

async function makeRelease({ version = "0.2.0" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vl-release-"));
  const pkg = path.join(root, "pkg");
  const out = root; // 发布产物与 zip 同目录（真实布局一致）
  await fs.mkdir(path.join(pkg, "app"), { recursive: true });
  await fs.writeFile(path.join(pkg, "app", "server.mjs"), "export const x = 1;\n", "utf8");
  await fs.writeFile(path.join(pkg, "VERSION.txt"), `VRlink v${version}\n`, "utf8");
  const sums = [
    ["app/server.mjs"],
    ["VERSION.txt"],
  ];
  const lines = [];
  for (const [relative] of sums) {
    lines.push(`${await sha256(path.join(pkg, relative))}  ${relative}`);
  }
  await fs.writeFile(path.join(pkg, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
  const zip = path.join(root, `VRlink-v${version}.zip`);
  await fs.writeFile(zip, Buffer.from("fake-zip-content-" + version));
  const keyDir = path.join(root, "keys");
  const init = run(["init-key", "--out", keyDir]);
  assert.equal(init.code, 0, init.stderr);
  const sign = run([
    "sign",
    "--zip", zip,
    "--dir", pkg,
    "--key", path.join(keyDir, "vrlink-seed-release.key"),
    "--version", version,
    "--channel", "seed",
    "--out", out,
  ]);
  assert.equal(sign.code, 0, sign.stderr);
  return { root, pkg, out, zip, keyDir };
}

test("release: 签名后校验通过（签名 + 包 sha256 + 逐文件）", async () => {
  const { root, pkg, out } = await makeRelease();
  const verify = run(["verify", "--release", out, "--dir", pkg]);
  const json = JSON.parse(verify.stdout);
  assert.equal(verify.code, 0);
  assert.equal(json.signature, true);
  assert.equal(json.packageSha256Match, true);
  assert.equal(json.filesMatch, true);
  assert.equal(json.files, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("release: 包内文件被改动后校验失败", async () => {
  const { root, pkg, out } = await makeRelease();
  await fs.appendFile(path.join(pkg, "app", "server.mjs"), "// tampered\n");
  const verify = run(["verify", "--release", out, "--dir", pkg]);
  const json = JSON.parse(verify.stdout);
  assert.equal(verify.code, 1);
  assert.equal(json.ok, false);
  assert.equal(json.filesMatch, false);
  assert.equal(json.fileMismatches[0].reason, "sha256");
  await fs.rm(root, { recursive: true, force: true });
});

test("release: zip 被替换后包哈希不匹配", async () => {
  const { root, out, zip } = await makeRelease();
  await fs.writeFile(zip, Buffer.from("different-bytes"));
  const verify = run(["verify", "--release", out]);
  const json = JSON.parse(verify.stdout);
  assert.equal(verify.code, 1);
  assert.equal(json.packageSha256Match, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("release: 更新检查能比版本、能下载并校验 sha256", async () => {
  const { root, out } = await makeRelease();
  const same = run(["check", "--source", path.join(out, "latest.json"), "--pub", path.join(out, "release.pub"), "--local-version", "0.2.0"]);
  assert.equal(same.code, 0);
  assert.equal(JSON.parse(same.stdout).newer, false);

  const download = path.join(root, "downloads");
  const older = run([
    "check",
    "--source", path.join(out, "latest.json"),
    "--pub", path.join(out, "release.pub"),
    "--local-version", "0.1.0",
    "--download-to", download,
  ]);
  const json = JSON.parse(older.stdout);
  assert.equal(older.code, 0);
  assert.equal(json.newer, true);
  assert.equal(json.downloadSha256Match, true);
  assert.ok(json.downloaded.endsWith("VRlink-v0.2.0.zip"));
  await fs.rm(root, { recursive: true, force: true });
});

test("release: latest.json 被篡改后签名校验失败", async () => {
  const { root, out } = await makeRelease();
  const latestPath = path.join(out, "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  latest.version = "9.9.9";
  const tampered = path.join(root, "latest-tampered.json");
  await fs.writeFile(tampered, JSON.stringify(latest), "utf8");
  const check = run(["check", "--source", tampered, "--pub", path.join(out, "release.pub"), "--local-version", "0.2.0"]);
  const json = JSON.parse(check.stdout);
  assert.equal(check.code, 1);
  assert.equal(json.signature, false);
  await fs.rm(root, { recursive: true, force: true });
});
