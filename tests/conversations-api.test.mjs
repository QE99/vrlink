import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-conv-"));
}

test("conversations API: 返回每条鱼最近一条消息与未读，按时间排序", async () => {
  const root = await tempDir();
  const pluginsDir = path.join(root, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const hub = await createHub({
    dataDir: path.join(root, "data"),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: "conv",
  });
  try {
    const port = await new Promise((resolve) => hub.server.listen(0, "127.0.0.1", () => resolve(hub.server.address().port)));
    const base = `http://127.0.0.1:${port}`;

    const created = await (
      await fetch(`${base}/api/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "会话测试鱼", persona: { identity: "测试" } }),
      })
    ).json();
    const id = created.character.id;

    const empty = await (await fetch(`${base}/api/conversations`)).json();
    assert.equal(empty.ok, true);
    const emptyRow = empty.conversations.find((row) => row.characterId === id);
    assert.equal(emptyRow.last, null);
    assert.equal(emptyRow.unread, 0);

    await fetch(`${base}/api/characters/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });

    const after = await (await fetch(`${base}/api/conversations`)).json();
    const row = after.conversations.find((item) => item.characterId === id);
    assert.ok(row.last, "should have last message");
    assert.equal(row.last.fromSelf, true, "last event is the fish's reply (message.sent)");
    assert.ok(row.last.text.length > 0);
    assert.ok(after.conversations.every((item, index, list) => index === 0 || (list[index - 1].last?.at ?? 0) >= (item.last?.at ?? 0)));
  } finally {
    await hub.federation.close();
    await hub.pluginHost.close();
    if (hub.server.listening) await new Promise((resolve) => hub.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
