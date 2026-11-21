#!/usr/bin/env node
/**
 * Small CLI for the local federation API.
 *
 * Usage:
 *   npm run federation -- status
 *   npm run federation -- card
 *   npm run federation -- invite [--json]
 *   npm run federation -- pending
 *   npm run federation -- confirm <pairId> [--reject]
 *   npm run federation -- connect <host:port | vrlink://... | card-json> [--auto]
 *   npm run federation -- peers
 *   npm run federation -- tank <nodeId>
 *   npm run federation -- chat <nodeId> <charId> <text...>
 *   npm run federation -- revoke <nodeId>
 *
 * Env:
 *   VRLINK_HUB_URL   default http://127.0.0.1:5274
 *   VRLINK_V2_TOKEN  optional local API token
 */
const base = (process.env.VRLINK_HUB_URL ?? "http://127.0.0.1:5274").replace(/\/+$/, "");
const token = process.env.VRLINK_V2_TOKEN ?? "";
const argv = process.argv.slice(2);
const command = argv[0] ?? "status";

function api(pathname) {
  return `${base}${pathname}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

async function request(pathname, options = {}) {
  const response = await fetch(api(pathname), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `HTTP ${response.status}`);
    error.code = body?.code ?? "HTTP_ERROR";
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function parseConnectArg(value) {
  if (!value) throw new Error("usage: connect <host:port>");
  const index = value.lastIndexOf(":");
  if (index < 1) throw new Error("connect target must be host:port");
  return { host: value.slice(0, index), port: Number(value.slice(index + 1)) };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  switch (command) {
    case "status": {
      print(await request("/api/federation/status"));
      return;
    }
    case "card": {
      const result = await request("/api/federation/card");
      print(result.card);
      return;
    }
    case "invite": {
      const result = await request("/api/federation/invite");
      if (argv.includes("--json")) {
        print(result.invite);
      } else {
        console.log(result.invite.link);
        console.log(`hints: ${(result.invite.hints ?? []).map((hint) => `${hint.host}:${hint.port}`).join(", ")}`);
      }
      return;
    }
    case "peers": {
      const result = await request("/api/federation/peers");
      if (!result.peers?.length) {
        console.log("no peers");
        return;
      }
      for (const peer of result.peers) {
        console.log(`${peer.name ?? "?"}  ${peer.nodeId}`);
        console.log(`  pairedAt: ${peer.pairedAt ?? "-"}  blocked: ${Boolean(peer.blocked)}`);
        console.log(`  grants:   ${JSON.stringify(peer.grants ?? {})}`);
      }
      return;
    }
    case "pending": {
      const result = await request("/api/federation/pending");
      if (!result.pending?.length) {
        console.log("no pending pairing requests");
        return;
      }
      for (const item of result.pending) {
        console.log(`${item.id}  SAS ${item.sas}  ${item.peer?.name ?? "?"}  ${item.peer?.nodeId ?? "?"}`);
      }
      return;
    }
    case "confirm": {
      const id = argv[1];
      if (!id) throw new Error("usage: confirm <pairId> [--reject]");
      print(
        await request("/api/federation/pending/confirm", {
          method: "POST",
          body: JSON.stringify({ id, accept: !argv.includes("--reject") }),
        }),
      );
      return;
    }
    case "connect": {
      const raw = argv[1];
      if (!raw) throw new Error("usage: connect <host:port | vrlink://... | card-json>");
      const isInvite = raw.startsWith("vrlink://") || raw.startsWith("{");
      const target = isInvite ? null : parseConnectArg(raw);
      console.log(`connecting to ${isInvite ? "invite" : `${target.host}:${target.port}`} ...`);
      if (!argv.includes("--auto")) {
        console.log("if the remote asks for confirmation, run `pending` + `confirm <id>` there.");
      }
      const result = await request("/api/federation/connect", {
        method: "POST",
        body: JSON.stringify(isInvite
          ? { invite: raw, autoConfirm: argv.includes("--auto") }
          : { ...target, autoConfirm: argv.includes("--auto") }),
      });
      print(result);
      return;
    }
    case "tank": {
      const nodeId = argv[1];
      if (!nodeId) throw new Error("usage: tank <nodeId>");
      const result = await request(`/api/federation/tank?nodeId=${encodeURIComponent(nodeId)}`);
      const tank = result.tank;
      console.log(`remote: ${tank.peer?.name ?? "?"}  ${tank.nodeId}`);
      for (const cert of tank.chars ?? []) {
        console.log(`  ${cert.name ?? "?"}  ${cert.char}  local=${cert.localId}`);
        const events = tank.events?.[cert.char] ?? [];
        for (const event of events.slice(-10)) {
          const text = event.content?.text ?? event.type;
          console.log(`    #${event.seq} ${event.type}: ${text}`);
        }
      }
      return;
    }
    case "chat": {
      const nodeId = argv[1];
      const charId = argv[2];
      const text = argv.slice(3).join(" ");
      if (!nodeId || !charId || !text) throw new Error("usage: chat <nodeId> <charId> <text...>");
      print(
        await request("/api/federation/chat", {
          method: "POST",
          body: JSON.stringify({ nodeId, char: charId, text }),
        }),
      );
      return;
    }
    case "revoke": {
      const nodeId = argv[1];
      if (!nodeId) throw new Error("usage: revoke <nodeId>");
      print(
        await request("/api/federation/revoke", {
          method: "POST",
          body: JSON.stringify({ nodeId }),
        }),
      );
      return;
    }
    default:
      console.log(`unknown command: ${command}`);
      console.log("commands: status card invite peers pending confirm connect tank chat revoke");
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`${error.code ?? "ERROR"}: ${error.message}`);
  if (error.body) console.error(JSON.stringify(error.body, null, 2));
  process.exitCode = 1;
});
