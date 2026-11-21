#!/usr/bin/env node
// Print the current connection status for VRlink v2.
const HUB = (process.env.VRLINK_HUB_URL || "http://127.0.0.1:5274").replace(/\/+$/, "");

async function get(path) {
  const response = await fetch(`${HUB}${path}`, { signal: AbortSignal.timeout(1500) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

try {
  const health = await get("/api/health");
  console.log(`Hub: ${HUB} -> ${health.status === 200 ? "OK" : `HTTP ${health.status}`}`);
  const connections = await get("/api/connections");
  const c = connections.data;
  console.log(`Home: ${c.home.source} (${c.home.deviceCount} devices)`);
  console.log(`OneBot bridge: ${c.onebot.online ? "online" : "offline"} ${c.onebot.url}`);
  console.log(`Bilibili bridge: ${c.bili.online ? "online" : "offline"} ${c.bili.url} (${c.bili.mode})`);
  console.log(`MCP: ${c.mcp.command}`);
  console.log(`ACP: ${c.acp.command}`);
} catch (error) {
  console.error(`Hub unreachable: ${HUB} (${error?.message ?? error})`);
  console.error("Start it first: cd <repo>; npm start");
  process.exitCode = 1;
}
