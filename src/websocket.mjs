import crypto from "node:crypto";

// Minimal RFC6455 server->client text frames for the life-stream event feed.
// Client -> server frames are only inspected for close; we do not accept commands over WS.
export function attachWebSocket(server, eventLog, { pathPrefix = "/ws/characters/" } = {}) {
  const clients = new Map(); // characterId -> Set<socket>
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) {
      for (const socket of set) {
        try {
          socket.write(Buffer.from([0x89, 0x00]));
        } catch {
          set.delete(socket);
        }
      }
    }
  }, 25000);
  heartbeat.unref?.();

  server.on("upgrade", (req, socket) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(pathPrefix)) return socket.destroy();
      const characterId = decodeURIComponent(url.pathname.slice(pathPrefix.length));
      if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(characterId)) return socket.destroy();
      const key = req.headers["sec-websocket-key"];
      if (!key) return socket.destroy();
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      const set = clients.get(characterId) ?? new Set();
      set.add(socket);
      clients.set(characterId, set);

      const cleanup = () => {
        set.delete(socket);
        if (!set.size) clients.delete(characterId);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      socket.on("data", (buffer) => {
        if (buffer.length && (buffer[0] & 0x0f) === 0x08) {
          try {
            socket.write(Buffer.from([0x88, 0x00]));
          } catch {
            /* ignore */
          }
          socket.end();
          cleanup();
        }
      });

      eventLog
        .read(characterId, { limit: 30 })
        .then((events) => sendJsonFrame(socket, { type: "snapshot", characterId, events }))
        .catch(() => {});
    } catch {
      socket.destroy();
    }
  });

  eventLog.on("event", (event) => {
    const set = clients.get(event.characterId);
    if (!set) return;
    const payload = JSON.stringify({ type: "event", event });
    for (const socket of set) {
      try {
        sendTextFrame(socket, payload);
      } catch {
        set.delete(socket);
      }
    }
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const set of clients.values()) {
      for (const socket of set) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }
    clients.clear();
  });

  return { clients };
}

function sendJsonFrame(socket, value) {
  sendTextFrame(socket, JSON.stringify(value));
}

function sendTextFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
