/**
 * 发行版门禁自检：验证 EDITION=seed 时
 *   - /api/health 报 edition=seed / platform
 *   - 空 data 不塞演示角色
 *   - 云端 API 大脑（engine=api）在创建/切换时被 403 拦住
 *   - 本地模型（engine=local）仍可切换
 * 用法：node tools/check-edition.mjs        （默认 EDITION=seed）
 *       EDITION=dev 或 VRLINK_EDITION=dev 时只打印当前行为
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.VRLINK_CHECK_PORT || 5394);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vl-edition-"));
const env = {
  ...process.env,
  VRLINK_EDITION: process.env.VRLINK_EDITION || "seed",
  VRLINK_V2_DATA: dir,
  VRLINK_V2_PORT: String(PORT),
  VRLINK_FEDERATION_PORT: "0",
};
const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
  env,
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
const base = `http://127.0.0.1:${PORT}`;
const fail = [];
const ok = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail.push(name);
};

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  ok("hub 起得来", up);
  const j = async (r) => [r.status, await r.json()];
  const post = (p, body) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const patch = (p, body) =>
    fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const [hs, health] = await j(await fetch(`${base}/api/health`));
  ok("health 200", hs === 200);
  ok("health 带 edition", typeof health.edition === "string", `edition=${health.edition}`);
  ok("health 带 platform", typeof health.platform === "string", `platform=${health.platform}`);

  const [ls, list0] = await j(await fetch(`${base}/api/characters`));
  ok("空 data 0 角色", ls === 200 && Array.isArray(list0.characters) && list0.characters.length === 0);

  const [cs, created] = await j(await post("/api/characters", { name: "自检鱼", persona: { identity: "本地" } }));
  ok("建 mock 角色 201", cs === 201 && created.ok === true);
  const id = created.character?.id;

  const [as, apiCreate] = await j(
    await post("/api/characters", { name: "云鱼", brain: { engine: "api", model: "deepseek-flash" } }),
  );
  const seed = (process.env.VRLINK_EDITION || "seed") === "seed" && process.env.VRLINK_ALLOW_CLOUD_API !== "1";
  ok(seed ? "seed 下 api 建角色被拒(403)" : "dev 下 api 建角色放行", seed ? as === 403 : as === 201, `status=${as}`);

  const [ps, patched] = await j(await patch(`/api/characters/${id}/brain`, { engine: "api" }));
  ok(seed ? "seed 下切 api 大脑被拒(403)" : "dev 下切 api 放行", seed ? ps === 403 : ps === 200, `status=${ps}`);
  if (ps === 403) ok("403 带可读原因", typeof patched.error === "string" && patched.error.length > 5);

  const [ts, local] = await j(await patch(`/api/characters/${id}/brain`, { engine: "local", model: "qwen2.5-1.5b" }));
  ok("切 local 大脑 200", ts === 200 && local.character?.brain?.engine === "local", `status=${ts}`);

  // 第二实例：玩家自己带了 Key（BYOK）→ seed 版应放行 api 引擎（不联网建角色/切引擎）
  if (!process.env.VRLINK_BRAIN_API_KEY) {
    const byokPort = PORT + 1;
    const byokDir = await fs.mkdtemp(path.join(os.tmpdir(), "vl-edition-byok-"));
    const byok = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
      env: {
        ...process.env,
        VRLINK_EDITION: "seed",
        VRLINK_V2_DATA: byokDir,
        VRLINK_V2_PORT: String(byokPort),
        VRLINK_FEDERATION_PORT: "0",
        VRLINK_BRAIN_API_KEY: "byok-self-test-key",
      },
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const byokBase = `http://127.0.0.1:${byokPort}`;
    try {
      let up2 = false;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${byokBase}/api/health`)).ok) {
            up2 = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      ok("BYOK 实例起得来", up2);
      const r = await fetch(`${byokBase}/api/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "BYOK鱼", brain: { engine: "api", model: "deepseek-flash" } }),
      });
      ok("玩家自带 Key 时 seed 允许 api 引擎", r.status === 201, `status=${r.status}`);
    } finally {
      byok.kill();
      await fs.rm(byokDir, { recursive: true, force: true });
    }
  }
} finally {
  child.kill();
}
await fs.rm(dir, { recursive: true, force: true });
if (fail.length) {
  console.error(`\nFAILED: ${fail.join(", ")}`);
  process.exit(1);
}
console.log("\nALL PASS");
