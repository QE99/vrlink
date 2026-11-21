import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createLocalBrain, chatCompletionsUrl } from "../src/brains/local.mjs";

test("local brain: chatCompletionsUrl 接受带/不带 /v1 两种写法", () => {
  assert.equal(chatCompletionsUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(chatCompletionsUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(chatCompletionsUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(chatCompletionsUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1/chat/completions");
});

test("local brain: baseUrl 已带 /v1 时也能真实请求（不重复 /v1/v1）", async () => {
  const seen = [];
  const fake = http.createServer(async (req, res) => {
    seen.push(req.url);
    for await (const _ of req) {
      /* drain */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "本地OK。" } }] }));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${fake.address().port}/v1`;
    const brain = createLocalBrain({ baseUrl: base });
    const result = await brain.generate({
      character: { name: "本地鱼", persona: { identity: "本地" } },
      event: { content: { text: "在吗" } },
      context: [],
      memories: [],
    });
    assert.equal(result.text, "本地OK。");
    assert.deepEqual(seen, ["/v1/chat/completions"]);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});
