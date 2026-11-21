// Bilibili bridge (draft-only).
// Bilibili has no official bot API; this bridge accepts events pushed by a user-side
// extension/userscript, asks VRlink for a draft reply, and returns the draft.
// It NEVER posts comments/danmaku/DMs automatically. That is a product red line.
import http from "node:http";
import { pathToFileURL } from "node:url";

export async function createBilibiliBridge({
  hubUrl = "http://127.0.0.1:5274",
  characterId = "lin_wan",
  host = "127.0.0.1",
  port = 5701,
  hubToken = "",
  log = console.log,
} = {}) {
  const base = hubUrl.replace(/\/+$/, "");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return sendJson(res, 200, { ok: true, mode: "draft-only", characterId });
    }
    if (req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/bili")) {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    try {
      const body = await readJson(req);
      const event = normalizeBilibiliEvent(body);
      if (!event) return sendJson(res, 400, { ok: false, error: "text required" });
      const response = await fetch(`${base}/api/characters/${encodeURIComponent(characterId)}/draft`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(hubToken ? { authorization: `Bearer ${hubToken}` } : {}),
        },
        body: JSON.stringify(event),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data?.error ?? `hub HTTP ${response.status}`);
      log(`[bili] draft for ${event.thread} (not sent)`);
      return sendJson(res, 200, { ok: true, mode: "draft-only", draft: data.draft ?? "", thread: event.thread });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: actualPort,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function normalizeBilibiliEvent(input) {
  if (!input || typeof input !== "object") return null;
  const text = String(input.text ?? "").trim();
  if (!text) return null;
  const type = String(input.type ?? "comment");
  const visibility = input.visibility ?? (type === "dm" ? "private" : "public");
  const thread = String(input.thread ?? `bili:${type}`);
  const user = input.user ?? {};
  return {
    body: "bili",
    thread,
    actor: {
      id: String(user.id ?? "bili_user"),
      name: String(user.name ?? "B站用户"),
      relation: "bili",
    },
    visibility,
    text,
  };
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
  createBilibiliBridge({
    hubUrl: process.env.VRLINK_HUB_URL || "http://127.0.0.1:5274",
    characterId: process.env.VRLINK_CHARACTER_ID || "lin_wan",
    host: process.env.BILI_WEBHOOK_HOST || "127.0.0.1",
    port: Number(process.env.BILI_WEBHOOK_PORT || 5701),
    hubToken: process.env.VRLINK_HUB_TOKEN || "",
  })
    .then((bridge) => console.log(`Bilibili draft bridge listening on http://127.0.0.1:${bridge.port} (draft-only)`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
