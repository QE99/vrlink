// OneBot 11 bridge (HTTP webhook -> VRlink Hub -> OneBot API).
// Your OneBot implementation (NapCat/LLOneBot/etc.) pushes message events here.
// This is an adapter skeleton: no bundled protocol implementation, no account credentials.
import http from "node:http";
import { pathToFileURL } from "node:url";

export async function createOneBotBridge({
  hubUrl = "http://127.0.0.1:5274",
  characterId = "lin_wan",
  onebotApiBase = "",
  onebotToken = "",
  host = "127.0.0.1",
  port = 5700,
  hubToken = "",
  log = console.log,
} = {}) {
  const base = hubUrl.replace(/\/+$/, "");
  const apiBase = onebotApiBase.replace(/\/+$/, "");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return sendJson(res, 200, { ok: true, characterId, onebotApiBase: apiBase });
    }
    if (req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/onebot")) {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    try {
      const event = await readJson(req);
      sendJson(res, 200, { ok: true });
      processEvent(event).catch((error) => log(`[onebot] event failed: ${error?.message ?? error}`));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  async function processEvent(event) {
    const normalized = normalizeOneBotEvent(event);
    if (!normalized) return { ok: true, ignored: true };
    const response = await fetch(`${base}/api/characters/${encodeURIComponent(characterId)}/simulate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(hubToken ? { authorization: `Bearer ${hubToken}` } : {}),
      },
      body: JSON.stringify(normalized),
    });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(data?.error ?? `hub HTTP ${response.status}`);
    const reply = data.produced?.find((item) => item.type === "message.sent")?.content?.text ?? "";
    if (reply && apiBase) await sendToOneBot(normalized, reply);
    return { ok: true, reply };
  }

  async function sendToOneBot(normalized, text) {
    const isGroup = normalized.thread.startsWith("group:");
    const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
    const body = isGroup
      ? { group_id: Number(normalized.thread.slice("group:".length)), message: text }
      : { user_id: Number(normalized.actor.id), message: text };
    const response = await fetch(`${apiBase}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(onebotToken ? { authorization: `Bearer ${onebotToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(data?.error ?? `onebot HTTP ${response.status}`);
    log(`[onebot] replied to ${normalized.thread}`);
    return data;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: actualPort,
    processEvent,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function normalizeOneBotEvent(event) {
  if (!event || event.post_type !== "message") return null;
  if (event.user_id !== undefined && event.self_id !== undefined && String(event.user_id) === String(event.self_id)) return null;
  const text = extractText(event);
  if (!text) return null;
  const isGroup = event.message_type === "group";
  const groupId = event.group_id;
  const userId = event.user_id;
  return {
    body: "qq",
    thread: isGroup ? `group:${groupId}` : `private:${userId}`,
    actor: {
      id: String(userId ?? "unknown"),
      name: String(event.sender?.card || event.sender?.nickname || userId || "QQ 用户"),
      relation: "qq",
    },
    visibility: isGroup ? "group" : "private",
    text,
  };
}

function extractText(event) {
  if (typeof event.raw_message === "string" && event.raw_message.trim()) return event.raw_message.trim();
  if (Array.isArray(event.message)) {
    return event.message
      .filter((segment) => segment?.type === "text")
      .map((segment) => segment?.data?.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createOneBotBridge({
    hubUrl: process.env.VRLINK_HUB_URL || "http://127.0.0.1:5274",
    characterId: process.env.VRLINK_CHARACTER_ID || "lin_wan",
    onebotApiBase: process.env.ONEBOT_API_BASE || "",
    onebotToken: process.env.ONEBOT_ACCESS_TOKEN || "",
    host: process.env.ONEBOT_WEBHOOK_HOST || "127.0.0.1",
    port: Number(process.env.ONEBOT_WEBHOOK_PORT || 5700),
    hubToken: process.env.VRLINK_HUB_TOKEN || "",
  })
    .then((bridge) => console.log(`OneBot webhook listening on http://127.0.0.1:${bridge.port} (character=${process.env.VRLINK_CHARACTER_ID || "lin_wan"})`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
