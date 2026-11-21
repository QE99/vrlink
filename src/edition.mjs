/**
 * 发行版 / 平台门禁（2026-11-08，M4 收尾期新增）
 *
 * EDITION=dev （默认）：开发/测试版。行为和 M0–M3.6 完全一致。
 * EDITION=seed        ：玩家种子包 / 发行版。包里不带任何我们的云端 API 配置，
 *                       默认拒绝 engine=api（云端大脑），只跑 mock / local。
 *
 * 逃生口：玩家明确要接自己的模型时，设 VRLINK_ALLOW_CLOUD_API=1 再启动；
 *         你自己的 Key 只放环境变量，不落盘、不进包。
 */
export const EDITION = (() => {
  const raw = String(process.env.VRLINK_EDITION ?? "dev").trim().toLowerCase();
  return raw === "seed" ? "seed" : "dev";
})();

export const IS_SEED = EDITION === "seed";
export const PLATFORM = process.platform;
export const IS_ANDROID = process.platform === "android";

export function cloudApiAllowed() {
  // dev 版不管；seed 版必须是"玩家自己带 Key"才放行——包里永远不带我们的 Key。
  if (!IS_SEED) return true;
  if (process.env.VRLINK_ALLOW_CLOUD_API === "1") return true;
  return Boolean(String(process.env.VRLINK_BRAIN_API_KEY ?? "").trim());
}

export const CLOUD_API_BLOCKED =
  "本发行版不带任何云端 API Key / API 配置。想用云端模型，请自己设 VRLINK_BRAIN_BASE_URL、VRLINK_BRAIN_API_KEY、VRLINK_BRAIN_MODEL 后重启；或用本地模型（engine=local）。";
