import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

test("network lan API: 能把联邦监听切到 0.0.0.0 再切回 127.0.0.1", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vrlink-lan-"));
  const pluginsDir = path.join(root, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const hub = await createHub({
    dataDir: path.join(root, "data"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: "lan-test",
  });
  try {
    const port = await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", () => resolve(hub.server.address().port)));
    const base = `http://127.0.0.1:${port}`;
    assert.equal(hub.federation.listenAddress.host, "127.0.0.1");

    const on = await (await fetch(`${base}/api/network/lan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })).json();
    assert.equal(on.ok, true);
    assert.equal(on.enabled, true);
    assert.equal(on.federation.host, "0.0.0.0");
    assert.ok(Array.isArray(on.hints) && on.hints.length > 0);
    assert.ok(on.hints.some((hint) => hint.host === "127.0.0.1"), "loopback hint should stay");
    assert.equal(hub.federation.listenAddress.host, "0.0.0.0");

    const off = await (await fetch(`${base}/api/network/lan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(off.ok, true);
    assert.equal(off.federation.host, "127.0.0.1");
  } finally {
    await hub.federation.close();
    await hub.pluginHost.close();
    if (hub.server.listening) await new Promise((resolve) => hub.server.close(resolve));
    // 让 relisten 关闭的 socket 句柄先完成事件循环回调，否则 Windows 上进程退出时可能触发 libuv 断言
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.rm(root, { recursive: true, force: true });
  }
});
