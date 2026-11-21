/**
 * Out-of-band invite links.
 *
 * A link is deliberately self-contained but small:
 *   vrlink://connect?node=...&name=...&hint=host:port&hint=...
 *
 * It is not a directory entry and it does not grant access by itself.
 * The first connection still has to pass the normal signed handshake + SAS.
 */

function normalizeHost(host) {
  const value = String(host ?? "").trim();
  if (!value) return "";
  if (value === "0.0.0.0" || value === "::" || value === "[::]") return "";
  return value;
}

function splitHostPort(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const index = text.lastIndexOf(":");
  if (index <= 0) return null;
  const host = text.slice(0, index);
  const port = Number(text.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function hintsFromCard(card) {
  const raw = Array.isArray(card?.hints) ? card.hints : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const host = normalizeHost(item.host);
    const port = Number(item.port);
    if (host && Number.isInteger(port) && port > 0 && port <= 65535) out.push({ host, port });
  }
  return out;
}

export function createInvite({ card, hints = [], name = "", publicHost = "" } = {}) {
  if (!card?.node?.nodeId) throw new Error("invite: signed card required");
  const usable = [];
  const firstHost = normalizeHost(publicHost);
  if (firstHost) {
    const ports = hints.map((hint) => Number(hint?.port)).filter((port) => Number.isInteger(port) && port > 0);
    usable.push({ host: firstHost, port: ports[0] ?? 5275 });
  }
  for (const hint of hints) {
    const host = normalizeHost(hint?.host);
    const port = Number(hint?.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!usable.some((item) => item.host === host && item.port === port)) usable.push({ host, port });
  }
  if (!usable.length) usable.push({ host: "127.0.0.1", port: 5275 });

  const link = new URL("vrlink://connect");
  link.searchParams.set("v", "1");
  link.searchParams.set("node", card.node.nodeId);
  link.searchParams.set("name", name || card.name || card.node.name || card.node.fingerprint || "");
  if (card.node.fingerprint) link.searchParams.set("fp", card.node.fingerprint);
  for (const hint of usable) link.searchParams.append("hint", `${hint.host}:${hint.port}`);
  link.searchParams.set("host", usable[0].host);
  link.searchParams.set("port", String(usable[0].port));
  return { link: link.toString(), hints: usable };
}

export function parseInvite(input) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("invite: empty");
  if (text.startsWith("{")) {
    const card = JSON.parse(text);
    const hints = hintsFromCard(card);
    if (!hints.length) throw new Error("invite: card has no usable hint");
    return { nodeId: card.node?.nodeId ?? "", name: card.name ?? "", hints, host: hints[0].host, port: hints[0].port, card };
  }
  if (text.startsWith("vrlink://")) {
    const link = new URL(text);
    if (link.protocol !== "vrlink:" || link.hostname !== "connect") throw new Error("invite: not a connect link");
    const nodeId = link.searchParams.get("node") ?? "";
    const name = link.searchParams.get("name") ?? "";
    const hints = [];
    for (const value of link.searchParams.getAll("hint")) {
      const item = splitHostPort(value);
      if (item) hints.push(item);
    }
    const host = normalizeHost(link.searchParams.get("host"));
    const port = Number(link.searchParams.get("port"));
    if (host && Number.isInteger(port) && port > 0) hints.push({ host, port });
    const unique = [];
    for (const item of hints) {
      if (!unique.some((x) => x.host === item.host && x.port === item.port)) unique.push(item);
    }
    if (!unique.length) throw new Error("invite: link has no address");
    return { nodeId, name, hints: unique, host: unique[0].host, port: unique[0].port };
  }
  const item = splitHostPort(text);
  if (!item) throw new Error("invite: expected vrlink:// link, card JSON, or host:port");
  return { nodeId: "", name: "", hints: [item], host: item.host, port: item.port };
}
