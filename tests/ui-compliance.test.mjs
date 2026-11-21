import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const UI = path.join(process.cwd(), "ui");

// 合规红线：界面文案里不得出现指向"养鱼"事件或腾讯品牌的词。
// 这些词只允许出现在内部文档/日志里，不允许出现在随包发布的 UI 资源中。
const BANNED = [/养鱼/, /鱼缸/, /鱼住/, /鱼友/, /微信式/, /腾讯/, /\bQQ\b/, /封号/, /律师函/];

test("合规：随包 UI 文案不含养鱼/鱼缸/鱼住/微信式/腾讯/QQ 等术语", async () => {
  for (const file of ["wx.js", "wx.html", "guest.js", "guest.html", "wx.css"]) {
    const text = await fs.readFile(path.join(UI, file), "utf8");
    for (const pattern of BANNED) {
      assert.doesNotMatch(text, pattern, `${file} 不应包含 ${pattern}`);
    }
  }
});

test("合规：旧版页面已从 ui 目录移除（发布包不带旧文案）", async () => {
  for (const file of ["app.js", "v2.js", "v2.html", "v2.css", "index.html", "style.css"]) {
    await assert.rejects(fs.access(path.join(UI, file)), `${file} 应已删除`);
  }
});
