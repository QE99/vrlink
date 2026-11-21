#!/usr/bin/env node
/**
 * VRlink 发行签名 / 校验 / 更新检查工具（无第三方依赖，Node >=18）
 *
 * 子命令：
 *   init-key  --out <dir>                       生成 Ed25519 发布密钥对（私钥只留本机，勿上传/进包）
 *   sign      --zip <zip> --dir <构建目录>        对发行包生成 release.json + release.pub + latest.json
 *             --key <私钥pem> --version <ver> [--channel seed] [--out <dir>] [--url <下载URL>]
 *   verify    --release <目录> [--dir <解压后的包>] 校验签名 + 包 SHA256 + 逐文件 SHA256
 *   check     --source <latest.json 路径或 URL> --pub <release.pub> --local-version <ver>
 *             [--download-to <目录>]             检查是否有新版本；可选下载并校验 sha256
 *
 * 设计口径：
 * - 签名对象是「规范化 JSON」（键排序、无空白）的 manifest 本体；signature 字段不参与签名。
 * - latest.json 自签（含 package.sha256）；release.pub 随包分发，玩家可用它离线验签。
 * - 私钥只在本地密钥目录，绝不进包、不进仓库、不上传。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_RELEASE = "vrlink-release/1";
const SCHEMA_UPDATE = "vrlink-update/1";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`missing --${name}`);
  return value;
}

async function readSumsFile(file) {
  const text = await fs.readFile(file, "utf8");
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s{1,2}(.+)$/i);
    if (!match) continue;
    files.push({ path: match[2].trim().replace(/\\/g, "/"), sha256: match[1].toLowerCase() });
  }
  return files;
}

async function loadPublicKey(pemOrPath) {
  let pem = pemOrPath;
  if (!pem.includes("BEGIN PUBLIC KEY")) pem = await fs.readFile(pemOrPath, "utf8");
  return crypto.createPublicKey(pem);
}

async function loadPrivateKey(pemOrPath) {
  let pem = pemOrPath;
  if (!pem.includes("BEGIN PRIVATE KEY")) pem = await fs.readFile(pemOrPath, "utf8");
  return crypto.createPrivateKey(pem);
}

function signBody(body, privateKey) {
  const data = Buffer.from(stableStringify(body), "utf8");
  return crypto.sign(null, data, privateKey).toString("base64");
}

function verifyBody(body, signature, publicKey) {
  const data = Buffer.from(stableStringify(body), "utf8");
  try {
    return crypto.verify(null, data, publicKey, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

async function commandInitKey(options) {
  const out = options.out ? String(options.out) : ".";
  await fs.mkdir(out, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  const privPath = path.join(out, "vrlink-seed-release.key");
  const pubPath = path.join(out, "vrlink-seed-release.pub");
  await fs.writeFile(privPath, privPem, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(pubPath, pubPem, "utf8");
  console.log(JSON.stringify({ ok: true, privateKey: privPath, publicKey: pubPath }, null, 2));
}

async function commandSign(options) {
  const zip = path.resolve(requireOption(options, "zip"));
  const buildDir = path.resolve(requireOption(options, "dir"));
  const keyPath = path.resolve(requireOption(options, "key"));
  const version = String(requireOption(options, "version"));
  const channel = String(options.channel ?? "seed");
  const outDir = path.resolve(options.out ? String(options.out) : path.dirname(zip));
  const url = String(options.url ?? path.basename(zip));

  const stat = await fs.stat(zip);
  const zipSha = await sha256File(zip);
  const sumsFile = path.join(buildDir, "SHA256SUMS.txt");
  const filesRaw = await readSumsFile(sumsFile);
  if (!filesRaw.length) throw new Error(`no file hashes found in ${sumsFile}`);

  const files = [];
  for (const entry of filesRaw) {
    const absolute = path.join(buildDir, ...entry.path.split("/"));
    const info = await fs.stat(absolute);
    files.push({ path: entry.path, size: info.size, sha256: entry.sha256 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const privateKey = await loadPrivateKey(keyPath);
  const publicPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();

  const manifestBody = {
    schema: SCHEMA_RELEASE,
    version,
    channel,
    createdAt: new Date().toISOString(),
    package: { file: path.basename(zip), size: stat.size, sha256: zipSha },
    files,
    publicKey: publicPem,
  };
  const signature = signBody(manifestBody, privateKey);

  const latestBody = {
    schema: SCHEMA_UPDATE,
    version,
    channel,
    releasedAt: manifestBody.createdAt,
    package: { file: path.basename(zip), size: stat.size, sha256: zipSha, url },
    publicKey: publicPem,
  };
  const latestSignature = signBody(latestBody, privateKey);

  await fs.mkdir(outDir, { recursive: true });
  const releaseFile = path.join(outDir, "release.json");
  const pubFile = path.join(outDir, "release.pub");
  const latestFile = path.join(outDir, "latest.json");
  await fs.writeFile(releaseFile, JSON.stringify({ ...manifestBody, signature }, null, 2), "utf8");
  await fs.writeFile(pubFile, publicPem + "\n", "utf8");
  await fs.writeFile(latestFile, JSON.stringify({ ...latestBody, signature: latestSignature }, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    version,
    channel,
    release: releaseFile,
    latest: latestFile,
    publicKey: pubFile,
    package: { file: path.basename(zip), size: stat.size, sha256: zipSha },
    fileCount: files.length,
  }, null, 2));
}

async function commandVerify(options) {
  const releaseDir = path.resolve(requireOption(options, "release"));
  const releaseRaw = JSON.parse(await fs.readFile(path.join(releaseDir, "release.json"), "utf8"));
  const { signature, ...body } = releaseRaw;
  const pem = releaseRaw.publicKey ?? (await fs.readFile(path.join(releaseDir, "release.pub"), "utf8"));
  const publicKey = await loadPublicKey(pem);
  const signatureOk = verifyBody(body, signature, publicKey);
  const result = { ok: signatureOk, signature: signatureOk, version: body.version, files: 0, packageSha256: body.package?.sha256 ?? null };

  const zipCandidates = [
    options.zip ? path.resolve(String(options.zip)) : null,
    path.join(releaseDir, body.package.file),
    path.join(path.dirname(releaseDir), body.package.file),
  ].filter(Boolean);
  for (const candidate of zipCandidates) {
    try {
      const zipSha = await sha256File(candidate);
      result.packageFile = true;
      result.packagePath = candidate;
      result.packageSha256Match = zipSha === body.package.sha256;
      break;
    } catch {
      // try next candidate
    }
  }
  if (result.packageFile === undefined) result.packageFile = false;

  if (options.dir) {
    const dir = path.resolve(String(options.dir));
    result.files = body.files.length;
    const mismatches = [];
    for (const file of body.files) {
      const absolute = path.join(dir, ...file.path.split("/"));
      try {
        const [sha, stat] = [await sha256File(absolute), await fs.stat(absolute)];
        if (sha !== file.sha256) mismatches.push({ path: file.path, reason: "sha256" });
        else if (stat.size !== file.size) mismatches.push({ path: file.path, reason: "size" });
      } catch {
        mismatches.push({ path: file.path, reason: "missing" });
      }
    }
    result.fileMismatches = mismatches;
    result.filesMatch = mismatches.length === 0;
  }

  const ok = result.signature && result.packageFile !== false && result.packageSha256Match !== false && (options.dir ? result.filesMatch : true);
  result.ok = Boolean(ok);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function compareVersions(a, b) {
  const split = (value) => String(value).replace(/^v/i, "").split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l > r ? 1 : -1;
    return String(l) > String(r) ? 1 : -1;
  }
  return 0;
}

async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${source}`);
    return { text: await response.text(), baseUrl: new URL(".", source).href };
  }
  const absolute = path.resolve(source);
  return { text: await fs.readFile(absolute, "utf8"), baseUrl: path.dirname(absolute) + path.sep };
}

async function commandCheck(options) {
  const source = requireOption(options, "source");
  const pubPath = path.resolve(requireOption(options, "pub"));
  const localVersion = String(requireOption(options, "local-version"));
  const { text, baseUrl } = await readSource(source);
  const latestRaw = JSON.parse(text);
  const { signature, ...body } = latestRaw;
  const publicKey = await loadPublicKey(await fs.readFile(pubPath, "utf8"));
  const signatureOk = verifyBody(body, signature, publicKey);
  const newer = compareVersions(body.version, localVersion) > 0;

  const result = {
    ok: signatureOk,
    signature: signatureOk,
    localVersion,
    remoteVersion: body.version,
    channel: body.channel,
    newer,
    package: body.package ?? null,
  };

  if (options["download-to"] && newer && signatureOk) {
    const targetDir = path.resolve(String(options["download-to"]));
    await fs.mkdir(targetDir, { recursive: true });
    const file = path.join(targetDir, body.package.file);
    const url = /^https?:\/\//i.test(body.package.url) ? body.package.url : baseUrl + body.package.url;
    if (/^https?:\/\//i.test(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    } else {
      const candidates = [path.resolve(url), path.resolve(baseUrl, body.package.url)];
      let copied = false;
      for (const candidate of candidates) {
        try {
          await fs.copyFile(candidate, file);
          copied = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!copied) throw new Error(`download failed: package not found next to ${source}`);
    }
    const sha = await sha256File(file);
    result.downloaded = file;
    result.downloadSha256Match = sha === body.package.sha256;
    result.ok = Boolean(result.ok && result.downloadSha256Match);
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "init-key": return commandInitKey(options);
    case "sign": return commandSign(options);
    case "verify": return commandVerify(options);
    case "check": return commandCheck(options);
    default:
      console.error("usage: node tools/release-manifest.mjs <init-key|sign|verify|check> [options]");
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exitCode = 1;
});
