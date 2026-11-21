import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-scan-"));
}

async function makeHub(root, name, options = {}) {
  const pluginsDir = path.join(root, `plugins-${name}`);
  await fs.mkdir(pluginsDir, { recursive: true });
  return createHub({
    dataDir: path.join(root, name),
    uiDir: path.join(process.cwd(), "ui"),
    pluginsDir,
    federationPort: 0,
    federationName: name,
    federationAutoAccept: true,
    ...options,
  });
}

async function listen(hub) {
  const port = await new Promise((resolve) =>
    hub.server.listen(0, "127.0.0.1", () => resolve(hub.server.address().port)),
  );
  return `http://127.0.0.1:${port}`;
}

async function closeHub(hub) {
  await hub.federation.close();
  await hub.pluginHost.close();
  if (hub.server.listening) await new Promise((resolve) => hub.server.close(resolve));
}

async function waitFor(check, { timeoutMs = 8000, intervalMs = 60, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function get(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, data: await response.json() };
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, data: await response.json() };
}

test("扫码加好友：解析邀请链接 → 发申请 → 对方确认 → 成为好友", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "scan-a");
  const b = await makeHub(root, "scan-b", { federationAutoAccept: false });
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const nodeB = b.identity.publicIdentity().nodeId;

    // 手工拼邀请链接：这条测的是"需要人工确认 SAS"的老流程，
    // 所以故意不走 GET /api/federation/invite（那会自动开接受窗口）。
    const link = `vrlink://connect?v=1&node=${encodeURIComponent(nodeB)}&name=B&hint=127.0.0.1%3A${b.federation.listenAddress.port}`;
    assert.match(link, /^vrlink:\/\/connect\?/);

    // 扫码后先解析：A 应该能读到 B 的 nodeId 与地址，且还不知道已配对
    const parsed = await post(baseA, "/api/federation/invite/parse", { invite: link });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.data.invite.nodeId, nodeB);
    assert.ok(parsed.data.invite.hints.length >= 1);
    assert.equal(parsed.data.known, false);

    // 发好友申请（异步），A 立刻拿到 attempt
    const started = await post(baseA, "/api/federation/connect", { invite: link, autoConfirm: true, async: true });
    assert.equal(started.status, 200);
    const attemptId = started.data.attempt.id;
    assert.match(attemptId, /^conn_/);
    assert.ok(["pending", "ok"].includes(started.data.attempt.state));

    // B 侧出现「新的朋友」待确认
    const pending = await waitFor(
      async () => {
        const row = await get(baseB, "/api/federation/pending");
        return (row.data.pending ?? []).find((item) => item.peer?.nodeId?.startsWith("vrl:node:")) ?? null;
      },
      { label: "B 收到配对请求" },
    );
    assert.match(pending.sas, /^\d{6}$/);

    // B 确认 SAS 后，A 的 attempt 应变成 ok
    const confirmed = await post(baseB, "/api/federation/pending/confirm", { id: pending.id, accept: true });
    assert.equal(confirmed.data.ok, true);

    const done = await waitFor(
      async () => {
        const row = await get(baseA, `/api/federation/connect/attempt?id=${encodeURIComponent(attemptId)}`);
        return row.data.attempt?.state === "ok" ? row.data.attempt : null;
      },
      { label: "A 的申请被接受" },
    );
    assert.equal(done.peer.nodeId, nodeB);
    assert.equal((await a.peerStore.get(nodeB))?.nodeId, nodeB);
    assert.equal((await b.peerStore.get(a.identity.publicIdentity().nodeId))?.nodeId, a.identity.publicIdentity().nodeId);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("扫码加好友：第一个地址连不通时不该干等十几秒（每地址最多 4 秒就换下一个）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "scan-fast-a");
  const b = await makeHub(root, "scan-fast-b");
  try {
    const baseA = await listen(a);
    await listen(b);
    const nodeB = b.identity.publicIdentity().nodeId;
    const realPort = b.federation.listenAddress.port;
    // 192.0.2.1 是保留给文档/测试的地址，正常网络里不可达（会走到连接超时）
    const link = `vrlink://connect?v=1&node=${encodeURIComponent(nodeB)}&name=B&hint=192.0.2.1%3A${realPort}&hint=127.0.0.1%3A${realPort}`;

    const startedAt = Date.now();
    const started = await post(baseA, "/api/federation/connect", { invite: link, autoConfirm: true, async: true });
    const attemptId = started.data.attempt.id;
    const done = await waitFor(
      async () => {
        const row = await get(baseA, `/api/federation/connect/attempt?id=${encodeURIComponent(attemptId)}`);
        return row.data.attempt?.state === "ok" ? row.data.attempt : null;
      },
      { timeoutMs: 15000, label: "换到可用地址后连上" },
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(done.peer.nodeId, nodeB);
    assert.ok(elapsed < 9000, `应在 9 秒内连上（实测 ${elapsed}ms；旧默认每个地址等 10 秒）`);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("断线时发的人-人消息会排队，自动重连后补发（发件人不用手动重发）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "outbox-a", { reconnectMs: 500 });
  const b = await makeHub(root, "outbox-b", { reconnectMs: 500 });
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const nodeA = a.identity.publicIdentity().nodeId;
    const nodeB = b.identity.publicIdentity().nodeId;
    await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
    await waitFor(() => a.federation.sessions.size === 1 && b.federation.sessions.size === 1, { label: "配对后在线" });

    // 人为断线，模拟"手机/笔记本掉线"
    a.federation.disconnect(nodeB);
    b.federation.disconnect(nodeA);
    await waitFor(() => a.federation.sessions.size === 0, { label: "A 断线" });

    const text = `离线时发的-${Date.now() % 100000}`;
    const sent = await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.delivery.ok, false);
    assert.equal(sent.data.delivery.queued, true, `应进入排队：${JSON.stringify(sent.data.delivery)}`);
    assert.equal((await b.humanStore.list(nodeA)).length, 0, "断线期间对方不应收到");

    // 自动重连 + 补发
    const received = await waitFor(
      async () => {
        const list = await b.humanStore.list(nodeA);
        return list.find((item) => item.text === text) ?? null;
      },
      { timeoutMs: 15000, label: "重连后自动补发" },
    );
    assert.equal(received.text, text);
    const chain = await b.humanStore.verifyThread(nodeA, a.identity.getNodeCert());
    assert.equal(chain.ok, true);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("邀请二维码：打开即自动开放组网，但配对仍需对方在「新的朋友」确认（0.4.3 恢复）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "invite-a");
  const b = await makeHub(root, "invite-b", { federationAutoAccept: false });
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const nodeB = b.identity.publicIdentity().nodeId;

    const inviteData = await get(baseB, "/api/federation/invite");
    assert.equal(inviteData.status, 200);
    const network = inviteData.data.invite.network ?? {};
    assert.equal(network.opened, true, `应自动开放组网：${JSON.stringify(network)}`);
    assert.equal(b.federation.listenAddress.host, "0.0.0.0");
    const networkJson = await fs.readFile(path.join(root, "invite-b", "network.json"), "utf8");
    assert.equal(JSON.parse(networkJson).enabled, true);

    const link = inviteData.data.invite.link;
    const started = await post(baseA, "/api/federation/connect", { invite: link, autoConfirm: true, async: true });
    const attemptId = started.data.attempt.id;

    // 对方必须看到待确认请求（不再自动加好友）
    const pending = await waitFor(
      async () => {
        const row = await get(baseB, "/api/federation/pending");
        return (row.data.pending ?? [])[0] ?? null;
      },
      { label: "B 收到好友申请" },
    );
    assert.match(pending.sas, /^\d{6}$/);
    await post(baseB, "/api/federation/pending/confirm", { id: pending.id, accept: true });

    const done = await waitFor(
      async () => {
        const row = await get(baseA, `/api/federation/connect/attempt?id=${encodeURIComponent(attemptId)}`);
        return row.data.attempt?.state === "ok" ? row.data.attempt : null;
      },
      { timeoutMs: 20000, label: "扫码方在对方确认后连上" },
    );
    assert.equal(done.peer.nodeId, nodeB);
    assert.equal((await a.peerStore.get(nodeB))?.nodeId, nodeB);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
test("扫码加好友：乱码/空链接被明确拒绝，不会偷偷连", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "scan-c");
  try {
    const baseA = await listen(a);
    const bad = await post(baseA, "/api/federation/invite/parse", { invite: "这不是邀请码" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, "BAD_INVITE");

    const missing = await post(baseA, "/api/federation/invite/parse", {});
    assert.equal(missing.status, 400);

    const attempt = await get(baseA, "/api/federation/connect/attempt?id=nope");
    assert.equal(attempt.status, 404);

    const noTarget = await post(baseA, "/api/federation/connect", { async: true });
    assert.equal(noTarget.status, 400);
  } finally {
    await closeHub(a);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
