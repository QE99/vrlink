#!/usr/bin/env node
// Minimal ACP (Agent Client Protocol) server over stdio.
// Best-effort skeleton: initialize / session/new / session/prompt / session/cancel.
// It routes prompts to the VRlink Hub and streams the reply as a session/update notification.
import readline from "node:readline";

const HUB_URL = (process.env.VRLINK_HUB_URL || "http://127.0.0.1:5274").replace(/\/+$/, "");
const HUB_TOKEN = process.env.VRLINK_HUB_TOKEN || "";
const DEFAULT_CHARACTER = process.env.VRLINK_CHARACTER_ID || "lin_wan";

const sessions = new Map();
let seq = 0;

async function hub(path, options = {}) {
  const headers = { "content-type": "application/json" };
  if (HUB_TOKEN) headers.authorization = `Bearer ${HUB_TOKEN}`;
  const response = await fetch(`${HUB_URL}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message: String(message) } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (!method) return fail(id, -32600, "invalid request");
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "session/new") {
    const characterId = String(params?.metadata?.characterId ?? DEFAULT_CHARACTER);
    const characters = await hub("/api/characters");
    if (!characters.characters.some((character) => character.id === characterId)) {
      return fail(id, -32001, `character not found: ${characterId}`);
    }
    const sessionId = `acp_${Date.now().toString(36)}_${++seq}`;
    sessions.set(sessionId, { characterId });
    return reply(id, { sessionId });
  }
  if (method === "session/load") {
    const session = sessions.get(String(params?.sessionId ?? ""));
    if (!session) return fail(id, -32001, "session not found");
    return reply(id, {});
  }
  if (method === "session/prompt") {
    const sessionId = String(params?.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) return fail(id, -32001, "session not found");
    const parts = Array.isArray(params?.prompt) ? params.prompt : [];
    const text = parts
      .filter((part) => part?.type === "text" || part?.kind === "text")
      .map((part) => part.text ?? part?.data?.text ?? "")
      .join("")
      .trim();
    if (!text) return fail(id, -32602, "prompt text required");
    const result = await hub(`/api/characters/${encodeURIComponent(session.characterId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    const replyText = String(result.reply ?? "");
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: replyText },
      },
    });
    return reply(id, { stopReason: "end_turn" });
  }
  if (method === "session/cancel") {
    return reply(id, {});
  }
  return fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return fail(null, -32700, "parse error");
  }
  if (message && message.id === undefined) return;
  handle(message).catch((error) => fail(message?.id ?? null, -32603, error?.message ?? error));
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
