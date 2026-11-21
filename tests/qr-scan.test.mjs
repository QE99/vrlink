import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import QRCode from "qrcode";

/**
 * ui/vendor/jsqr.js 是 UMD（浏览器里挂 window.jsQR）。
 * 本项目的 package.json 是 type=module，直接 require 会把它当 ESM，
 * 所以这里按浏览器的方式用 module 垫片把源码跑一遍，测的就是页面加载的那个文件。
 */
function loadVendoredJsQr() {
  const src = fs.readFileSync(path.join(process.cwd(), "ui", "vendor", "jsqr.js"), "utf8");
  const shim = { exports: {} };
  // eslint-disable-next-line no-new-func
  const run = new Function("module", "exports", "define", src);
  run(shim, shim.exports, undefined);
  return shim.exports;
}

const jsQR = loadVendoredJsQr();

/** 用 node-qrcode 的模块矩阵手绘一张 RGBA 图，再交给页面里同一个 jsQR 解码。 */
function renderQr(text, { scale = 6, quiet = 4 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const dim = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!data[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const offset = (py * dim + px) * 4;
          rgba[offset] = 0;
          rgba[offset + 1] = 0;
          rgba[offset + 2] = 0;
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return { rgba, dim };
}

test("扫一扫解码：ui/vendor/jsqr.js 能解出 VRlink 邀请链接", () => {
  const link = "vrlink://connect?v=1&node=vrl%3Anode%3AExampleNodeId123&name=%E5%B0%8F%E7%B1%B3&hint=192.168.1.7%3A5275&host=192.168.1.7&port=5275";
  const { rgba, dim } = renderQr(link);
  const result = jsQR(rgba, dim, dim);
  assert.ok(result, "应该解出二维码");
  assert.equal(result.data, link);
});

test("扫一扫解码：中文名字的邀请码也能原样解出", () => {
  const link = "vrlink://connect?v=1&node=vrl%3Anode%3AZhExample&name=%E9%98%BF%E7%94%B2%EF%BC%88%E7%AC%94%E8%AE%B0%E6%9C%AC%EF%BC%89&hint=203.0.113.10%3A5275";
  const { rgba, dim } = renderQr(link);
  const result = jsQR(rgba, dim, dim);
  assert.ok(result);
  assert.equal(result.data, link);
});
