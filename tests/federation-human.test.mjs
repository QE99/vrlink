import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHub } from "../src/server.mjs";
import { HumanStore } from "../src/federation/human.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vrlink-human-"));
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

async function waitFor(check, { timeoutMs = 6000, intervalMs = 40, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, data: await response.json() };
}

async function get(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, data: await response.json() };
}

async function pair(a, b) {
  const nodeA = a.identity.publicIdentity().nodeId;
  const nodeB = b.identity.publicIdentity().nodeId;
  await a.federation.connect("127.0.0.1", b.federation.listenAddress.port, { autoConfirm: true });
  await waitFor(
    () => a.federation.sessions.size === 1 && b.federation.sessions.size === 1,
    { label: "both sessions" },
  );
  return { nodeA, nodeB };
}

test("人-人通道：握手协商 human.v1，双端都能看到这个能力", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const { nodeB } = await pair(a, b);
    const sessionA = a.federation.sessions.get(nodeB);
    assert.ok(sessionA);
    assert.ok(sessionA.peer.caps.includes("human.v1"), "对端 caps 应包含 human.v1");
    assert.ok(a.federation.status().caps.includes("human.v1"));
    const peerA = await a.peerStore.get(nodeB);
    assert.equal(peerA.grants.human, true, "配对默认授予人-人通道");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：A 发给 B 的消息进人-人收件箱，不进任何角色的 Agent 日志", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const { nodeA, nodeB } = await pair(a, b);

    const beforeA = (await b.eventLog.read("lin_wan")).length;
    assert.ok(beforeA >= 0);

    const sent = await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "晚上好，我是 A。" });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.ok, true);
    assert.equal(sent.data.delivery.state, "sent");
    assert.equal(sent.data.message.from, nodeA);
    assert.equal(sent.data.message.to, nodeB);

    const received = await waitFor(
      async () => {
        const row = await get(baseB, `/api/human/${encodeURIComponent(nodeA)}/messages`);
        return row.data.messages?.length ? row.data : null;
      },
      { label: "B 收到人-人消息" },
    );
    assert.equal(received.messages.length, 1);
    assert.equal(received.messages[0].text, "晚上好，我是 A。");
    assert.equal(received.messages[0].from, nodeA);

    // 关键红线：人-人消息不得进入任何角色的事件日志 / 上下文
    const afterA = await b.eventLog.read("lin_wan");
    assert.equal(afterA.length, beforeA, "角色事件数不应变化");
    assert.equal(
      afterA.some((event) => String(event.content?.text ?? "").includes("晚上好，我是 A。")),
      false,
      "人-人消息不应出现在角色事件里",
    );

    // 回信：B → A
    const replied = await post(baseB, `/api/human/${encodeURIComponent(nodeA)}/messages`, { text: "收到，A 你好。" });
    assert.equal(replied.data.delivery.state, "sent");
    const back = await waitFor(
      async () => {
        const row = await get(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`);
        return row.data.messages?.length === 2 ? row.data : null;
      },
      { label: "A 收到回信" },
    );
    assert.equal(back.messages[1].text, "收到，A 你好。");
    assert.equal(back.messages[1].from, nodeB);

    // 两条链都要能整链验过
    const chainA = await a.humanStore.verifyThread(nodeB, b.identity.getNodeCert());
    assert.equal(chainA.ok, true, `A 侧链校验：${JSON.stringify(chainA)}`);
    const chainB = await b.humanStore.verifyThread(nodeA, a.identity.getNodeCert());
    assert.equal(chainB.ok, true, `B 侧链校验：${JSON.stringify(chainB)}`);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：篡改正文 / 改发件人都被拒，原件不落盘", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const { nodeA, nodeB } = await pair(a, b);
    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "原件" });
    const row = await waitFor(
      async () => {
        const value = await get(baseB, `/api/human/${encodeURIComponent(nodeA)}/messages`);
        return value.data.messages?.length ? value.data : null;
      },
      { label: "B 收到原件" },
    );
    const original = row.messages[0];

    const tampered = { ...original, text: "被改过的正文", seq: original.seq + 10 };
    const bad = await b.humanStore.receive({ nodeId: nodeA, peerCert: a.identity.getNodeCert(), message: tampered });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "BAD_ID");

    const forged = { ...original, from: b.identity.publicIdentity().nodeId, seq: original.seq + 10, prev: original.id };
    const forgedResult = await b.humanStore.receive({ nodeId: nodeA, peerCert: a.identity.getNodeCert(), message: forged });
    assert.equal(forgedResult.ok, false);

    const stillOne = await b.humanStore.list(nodeA);
    assert.equal(stillOne.length, 1, "被拒的消息不应落盘");
    assert.equal(stillOne[0].text, "原件");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：未读 / 已读、名片同步与线程列表", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const { nodeA, nodeB } = await pair(a, b);

    // 名片：A 改名字，B 端应通过 profile 推送拿到
    const renamed = await fetch(`${baseA}/api/human/self`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "阿甲", avatarText: "甲" }),
    }).then((response) => response.json());
    assert.equal(renamed.self.name, "阿甲");
    await waitFor(
      async () => {
        const threadRow = await get(baseB, "/api/human/threads");
        const item = (threadRow.data.threads ?? []).find((thread) => thread.nodeId === nodeA);
        return item?.name === "阿甲" ? item : null;
      },
      { label: "B 收到 A 的名片", timeoutMs: 30000 },
    );

    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "未读一条" });
    const threads = await waitFor(
      async () => {
        const value = await get(baseB, "/api/human/threads");
        const item = (value.data.threads ?? []).find((thread) => thread.nodeId === nodeA);
        return item?.unread > 0 ? item : null;
      },
      { label: "B 线程未读 +1", timeoutMs: 30000 },
    );
    assert.ok(threads.lastText.includes("未读一条"));
    assert.equal(threads.lastFromSelf, false);

    const read = await post(baseB, `/api/human/${encodeURIComponent(nodeA)}/read`, {});
    assert.equal(read.data.ok, true);
    const afterRead = await get(baseB, "/api/human/threads");
    const item = (afterRead.data.threads ?? []).find((thread) => thread.nodeId === nodeA);
    assert.equal(item.unread, 0);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：双方轮流各发多条也不会互相顶掉（回归：STALE_SEQ 丢消息）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "seq-a");
  const b = await makeHub(root, "seq-b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const { nodeA, nodeB } = await pair(a, b);
    for (let i = 1; i <= 3; i += 1) {
      const sentA = await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: `A-${i}` });
      assert.equal(sentA.data.delivery.ok, true, `A-${i} 应该送达：${JSON.stringify(sentA.data.delivery)}`);
      await waitFor(async () => (await b.humanStore.list(nodeA)).some((m) => m.text === `A-${i}`), {
        label: `B 收到 A-${i}`,
      });
      const sentB = await post(baseB, `/api/human/${encodeURIComponent(nodeA)}/messages`, { text: `B-${i}` });
      assert.equal(sentB.data.delivery.ok, true, `B-${i} 应该送达：${JSON.stringify(sentB.data.delivery)}`);
      await waitFor(async () => (await a.humanStore.list(nodeB)).some((m) => m.text === `B-${i}`), {
        label: `A 收到 B-${i}`,
      });
    }
    const aTexts = (await a.humanStore.list(nodeB)).map((item) => item.text);
    const bTexts = (await b.humanStore.list(nodeA)).map((item) => item.text);
    for (const text of ["A-1", "A-2", "A-3", "B-1", "B-2", "B-3"]) {
      assert.ok(aTexts.includes(text), `A 侧缺 ${text}: ${aTexts.join(",")}`);
      assert.ok(bTexts.includes(text), `B 侧缺 ${text}: ${bTexts.join(",")}`);
    }
    assert.equal((await a.humanStore.verifyThread(nodeB, b.identity.getNodeCert())).ok, true);
    assert.equal((await b.humanStore.verifyThread(nodeA, a.identity.getNodeCert())).ok, true);
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：本地缺过历史消息（老 bug 遗留）时，新消息仍然接收", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "gap-a");
  const b = await makeHub(root, "gap-b");
  try {
    const baseA = await listen(a);
    await listen(b);
    const { nodeA, nodeB } = await pair(a, b);
    for (const text of ["gap-1", "gap-2"]) {
      await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text });
      await waitFor(async () => (await b.humanStore.list(nodeA)).some((m) => m.text === text), { label: text });
    }
    // 从 B 的线程里删掉 A 的最后一条，模拟旧版本丢过消息
    const key = crypto.createHash("sha256").update(nodeA).digest("hex").slice(0, 24);
    const file = path.join(root, "gap-b", "human", "threads", key, "events.jsonl");
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    await fs.writeFile(file, `${lines.slice(0, -1).join("\n")}\n`, "utf8");

    const sent = await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "gap-3" });
    assert.equal(sent.data.delivery.ok, true, `新消息不该因历史断点被拒：${JSON.stringify(sent.data.delivery)}`);
    const got = await waitFor(
      async () => (await b.humanStore.list(nodeA)).find((m) => m.text === "gap-3") ?? null,
      { label: "B 收到 gap-3" },
    );
    assert.equal(got.text, "gap-3");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
test("收到人-人消息时调用宿主通知钩子（手机熄屏提醒的基础）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "notify-a");
  const b = await makeHub(root, "notify-b");
  const previous = globalThis.__vrlinkNotify;
  const calls = [];
  try {
    const baseA = await listen(a);
    await listen(b);
    await pair(a, b);
    const nodeB = b.identity.publicIdentity().nodeId;
    globalThis.__vrlinkNotify = (info) => calls.push(info);
    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "叮咚" });
    await waitFor(() => calls.length > 0, { label: "通知钩子被调用" });
    assert.equal(calls[0].kind, "human");
    assert.equal(calls[0].text, "叮咚");
    assert.ok(calls[0].name, `应带上好友名字：${JSON.stringify(calls[0])}`);
  } finally {
    globalThis.__vrlinkNotify = previous;
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人名片：默认不再叫「我」，两台机器默认名可区分；旧的「我」名片会自动迁移", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "name-a");
  const b = await makeHub(root, "name-b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const selfA = (await get(baseA, "/api/human/self")).data.self;
    const selfB = (await get(baseB, "/api/human/self")).data.self;
    assert.notEqual(selfA.name, "我", "默认名片不能叫「我」");
    assert.notEqual(selfB.name, "我");
    assert.notEqual(selfA.name, selfB.name, "两台机器的默认名应不同");

    // 没有起名字的节点：默认名直接用身份短码（不再加「鱼友」前缀），且两台机器不同
    const bare = await new HumanStore({
      dir: path.join(root, "bare-human"),
      identity: a.identity,
      name: "",
    }).init();
    const bareCard = await bare.getSelf();
    const fingerprint = a.identity.publicIdentity().fingerprint.slice(0, 4).toUpperCase();
    assert.equal(bareCard.name, fingerprint, `默认名应是身份短码：${bareCard.name}`);
    assert.ok(!/^鱼友/.test(bareCard.name), "默认名不再带「鱼友」前缀");

    // 旧版本写下的「我」/「鱼友 XXXX」名片：重开一次应迁移成身份短码
    await bare.setSelf({ name: "我" });
    const reopened = await new HumanStore({
      dir: path.join(root, "bare-human"),
      identity: a.identity,
      name: "",
    }).init();
    const migrated = await reopened.getSelf();
    assert.notEqual(migrated.name, "我");
    assert.equal(migrated.name, fingerprint);
    await reopened.setSelf({ name: "鱼友 ZZZZ" });
    const reopened2 = await new HumanStore({
      dir: path.join(root, "bare-human"),
      identity: a.identity,
      name: "",
    }).init();
    assert.equal((await reopened2.getSelf()).name, fingerprint, "旧「鱼友 XXXX」也要迁移");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("人-人通道：落盘可重开，链完整；旧对端（无 human.v1）明确拒绝", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "a");
  const b = await makeHub(root, "b");
  try {
    const baseA = await listen(a);
    await listen(b);
    const { nodeB } = await pair(a, b);
    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "写盘一条" });

    const reopened = await new HumanStore({
      dir: path.join(root, "a", "human"),
      identity: a.identity,
      name: "a",
    }).init();
    const messages = await reopened.list(nodeB);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "写盘一条");
    const chain = await reopened.verifyThread(nodeB, b.identity.getNodeCert());
    assert.equal(chain.ok, true);

    // 旧对端：把对端 caps 退回老版本，必须明确报 PEER_NO_HUMAN 而不是静默发到鱼的上下文
    const session = a.federation.sessions.get(nodeB);
    const savedCaps = session.peer.caps;
    session.peer.caps = ["events.v1", "chat.v1"];
    try {
      const message = await a.humanStore.appendLocal(nodeB, "旧对端");
      await assert.rejects(
        () => a.federation.humanSend(nodeB, message),
        (error) => error.code === "PEER_NO_HUMAN",
      );
    } finally {
      session.peer.caps = savedCaps;
    }
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("改名与头像：改了名字/头像后，对方线程和联系人里的名片都跟着更新", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "rename-a");
  const b = await makeHub(root, "rename-b");
  try {
    const baseA = await listen(a);
    const baseB = await listen(b);
    const { nodeA, nodeB } = await pair(a, b);
    await post(baseA, `/api/human/${encodeURIComponent(nodeB)}/messages`, { text: "先打个招呼" });
    await waitFor(async () => {
      const row = await get(baseB, "/api/human/threads");
      return (row.data.threads ?? []).some((thread) => thread.nodeId === nodeA);
    }, { label: "B 线程出现" });

    const changed = await fetch(`${baseA}/api/human/self`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "阿甲改名了", avatarText: "🐋", avatarData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }),
    });
    assert.equal(changed.status, 200);

    const thread = await waitFor(async () => {
      const row = await get(baseB, "/api/human/threads");
      const found = (row.data.threads ?? []).find((item) => item.nodeId === nodeA);
      return found?.name === "阿甲改名了" ? found : null;
    }, { label: "B 线程收到新名字" });
    assert.equal(thread.avatarText, "🐋", "头像也要同步");

    const peerRow = await waitFor(async () => {
      const row = await get(baseB, "/api/federation/peers");
      const found = (row.data.peers ?? []).find((item) => item.nodeId === nodeA);
      return found?.human?.name === "阿甲改名了" ? found : null;
    }, { label: "B 联系人名片收到新名字" });
    assert.equal(peerRow.human.avatarText, "🐋");
    assert.ok(String(peerRow.human.avatarData ?? "").startsWith("data:image/png;base64,"), "头像图片也要同步");
  } finally {
    await closeHub(a);
    await closeHub(b);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
test("名片：改过的名字和头像重启后还在（签名校验回归）", async () => {
  const root = await tempDir();
  const a = await makeHub(root, "persist-a");
  try {
    await a.humanStore.setSelf({ name: "持久化名字", avatarText: "🐯", avatarData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" });
    const { createHub } = await import("../src/server.mjs");
    const again = await createHub({
      dataDir: path.join(root, "persist-a"),
      uiDir: path.join(process.cwd(), "ui"),
      pluginsDir: path.join(root, "plugins-persist-a"),
      federationPort: 0,
      federationName: "persist-a",
      federationAutoAccept: true,
    });
    try {
      const self = await again.humanStore.getSelf();
      assert.equal(self.name, "持久化名字", "重启后不应重置名字");
      assert.equal(self.avatarText, "🐯");
      assert.ok(String(self.avatarData ?? "").startsWith("data:image/png;base64,"));
    } finally {
      await closeHub(again);
    }
  } finally {
    await closeHub(a);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});