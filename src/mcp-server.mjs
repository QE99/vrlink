#!/usr/bin/env node
// Minimal MCP (Model Context Protocol) server over stdio.
// It exposes VRlink characters, chat, devices, memory and audit as MCP tools/resources.
// stdout is reserved for JSON-RPC frames; diagnostics go to stderr.
import readline from "node:readline";

const HUB_URL = (process.env.VRLINK_HUB_URL || "http://127.0.0.1:5274").replace(/\/+$/, "");
const HUB_TOKEN = process.env.VRLINK_HUB_TOKEN || "";

const TOOLS = [
  {
    name: "vrlink_list_characters",
    description: "列出 VRlink 里面的房间",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vrlink_chat",
    description: "给指定角色发一句话，返回她的回复",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string", description: "角色 id，例如 lin_wan" },
        text: { type: "string", description: "要对她说的话" },
      },
      required: ["characterId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "vrlink_list_devices",
    description: "列出设备与状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vrlink_device_command",
    description: "控制设备；高风险设备会返回 CONSENT_REQUIRED，需要玩家批准",
    inputSchema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        deviceId: { type: "string" },
        command: { type: "string" },
        args: { type: "object" },
        approvalToken: { type: "string" },
      },
      required: ["characterId", "deviceId", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "vrlink_list_memory",
    description: "读取指定角色的记忆",
    inputSchema: {
      type: "object",
      properties: { characterId: { type: "string" }, limit: { type: "number" } },
      required: ["characterId"],
      additionalProperties: false,
    },
  },
  {
    name: "vrlink_audit",
    description: "读取指定角色的审计记录",
    inputSchema: {
      type: "object",
      properties: { characterId: { type: "string" }, limit: { type: "number" } },
      required: ["characterId"],
      additionalProperties: false,
    },
  },
];

async function hub(path, options = {}) {
  const headers = { "content-type": "application/json" };
  if (HUB_TOKEN) headers.authorization = `Bearer ${HUB_TOKEN}`;
  const response = await fetch(`${HUB_URL}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function callTool(name, args = {}) {
  if (name === "vrlink_list_characters") return hub("/api/characters");
  if (name === "vrlink_chat") {
    if (!args.characterId || !args.text) throw new Error("characterId and text required");
    return hub(`/api/characters/${encodeURIComponent(args.characterId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text: String(args.text) }),
    });
  }
  if (name === "vrlink_list_devices") return hub("/api/devices");
  if (name === "vrlink_device_command") {
    if (!args.characterId || !args.deviceId || !args.command) throw new Error("characterId, deviceId, command required");
    return hub(`/api/devices/${encodeURIComponent(args.deviceId)}/command`, {
      method: "POST",
      body: JSON.stringify({
        characterId: args.characterId,
        command: args.command,
        args: args.args ?? {},
        approvalToken: args.approvalToken,
      }),
    });
  }
  if (name === "vrlink_list_memory") {
    if (!args.characterId) throw new Error("characterId required");
    return hub(`/api/characters/${encodeURIComponent(args.characterId)}/memory?limit=${Number(args.limit ?? 100)}`);
  }
  if (name === "vrlink_audit") {
    if (!args.characterId) throw new Error("characterId required");
    return hub(`/api/audit?characterId=${encodeURIComponent(args.characterId)}&limit=${Number(args.limit ?? 100)}`);
  }
  throw new Error(`unknown tool: ${name}`);
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

async function handle(message) {
  const { id, method, params } = message;
  if (!method || typeof method !== "string") return fail(id, -32600, "invalid request");
  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "vrlink", version: "0.0.1" },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const result = await callTool(name, args);
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (error) {
      return reply(id, {
        content: [{ type: "text", text: String(error?.message ?? error) }],
        isError: true,
      });
    }
  }
  if (method === "resources/list") {
    const data = await hub("/api/characters");
    const resources = (data.characters ?? []).map((character) => ({
      uri: `vrlink://characters/${character.id}/events`,
      name: `${character.name} · 生活流`,
      mimeType: "application/json",
    }));
    return reply(id, { resources });
  }
  if (method === "resources/read") {
    const uri = String(params?.uri ?? "");
    const match = uri.match(/^vrlink:\/\/characters\/([a-z0-9][a-z0-9_-]{1,40})\/events$/);
    if (!match) return fail(id, -32602, `unsupported resource: ${uri}`);
    const data = await hub(`/api/characters/${encodeURIComponent(match[1])}/events?limit=100`);
    return reply(id, {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
    });
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
