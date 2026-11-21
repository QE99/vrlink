import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-search-"));
}

test("search API: 能搜角色名与消息文本，空查询返回空", async () => {
  const root = await tempDir();
  const pluginsDir = path.join(root, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const hub = await createHub({
    dataDir: path.join(root, "data"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: "search",
  });
  try {
    const port = await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", () => resolve(hub.server.address().port)));
    const base = `http://127.0.0.1:${port}`;
    const created = await (
      await fetch(`${base}/api/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "搜索鱼", persona: { identity: "住在搜索测试里" } }),
      })
    ).json();
    const id = created.character.id;
    await fetch(`${base}/api/characters/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "海底两万里计划" }),
    });

    const byName = await (await fetch(`${base}/api/search?q=${encodeURIComponent("搜索鱼")}`)).json();
    assert.equal(byName.ok, true);
    assert.ok(byName.characters.some((item) => item.characterId === id));

    const byMessage = await (await fetch(`${base}/api/search?q=${encodeURIComponent("海底两万里")}`)).json();
    assert.ok(byMessage.messages.some((item) => item.characterId === id && item.text.includes("海底两万里")));

    const empty = await (await fetch(`${base}/api/search?q=`)).json();
    assert.deepEqual(empty.characters, []);
    assert.deepEqual(empty.messages, []);
  } finally {
    await hub.federation.close();
    await hub.pluginHost.close();
    if (hub.server.listening) await new Promise((resolve) => hub.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
