import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-profile-sync-"));
}

async function makeHub(root, name) {
  const pluginsDir = path.join(root, `plugins-${name}`);
  await fs.mkdir(pluginsDir, { recursive: true });
  return createHub({
    dataDir: path.join(root, name),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: name,
    federationAutoAccept: true,
  });
}

async function closeHub(hub) {
  await hub.federation.close();
  await hub.pluginHost.close();
  if (hub.server.listening) {
    await new Promise((resolve) => hub.server.close(resolve));
  }
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("federation: 配对后新建角色会主动推 profile，对端不必重连即可见", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const nodeB = b.identity.publicIdentity().nodeId;
    const nodeA = a.identity.publicIdentity().nodeId;
    const session = await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    assert.equal(session.nodeId, nodeB);

    // 等 B 先拿到 A 的初始 profile
    await waitFor(() => b.federation.remoteTank(nodeA), { label: "B knows A tank" });
    const before = b.federation.remoteTank(nodeA).chars.length;

    const portA = await new Promise((resolve) => {
      a.server.listen(0, "127.0.0.1", () => resolve(a.server.address().port));
    });
    const response = await fetch(`http://127.0.0.1:${portA}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新鱼", persona: { identity: "两机复验后新建的鱼" } }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()).character;

    // 不重连、不重启：B 的远端鱼缸里应出现这条新鱼
    const tank = await waitFor(
      () => {
        const current = b.federation.remoteTank(nodeA);
        return current?.chars?.some((char) => char.localId === created.id) ? current : null;
      },
      { timeoutMs: 3000, label: "B sees the newly created character" },
    );
    assert.equal(tank.chars.length, before + 1);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true });
  }
});
