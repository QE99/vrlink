/* VRlink v2 · 分层式分层 UI（wx.js）
 * 纯原生 ES module，无构建、无 CDN。
 * 交互：底部 4 tab（桌面左 rail）+ 全屏 push 页 + hash 路由（浏览器/Android 返回键可退）。
 * 数据：/api/*（见 src/server.mjs），聊天真实调用 /api/characters/:id/chat。
 */

/* ======================================================================
 * 0. 基础工具
 * ==================================================================== */

import { sfx } from "./sfx/vrlink-sfx.js";

/* ---- 界面音效：启动就绪音（Chromium 在没有用户手势前会挂起 AudioContext） ---- */
let uiReadyPlayed = false;
let uiReadyArmed = false;

function playUiReady() {
  if (uiReadyPlayed) return;
  const ctx = sfx.context; // getter：第一次访问才创建 AudioContext
  if (ctx && ctx.state === "running") {
    uiReadyPlayed = true;
    void sfx.play("ui_ready");
    return;
  }
  uiReadyArmed = true; // 还没解锁：等第一次 pointerdown 补响
  sfx.unlock();
}

document.addEventListener("pointerdown", () => {
  if (!uiReadyArmed) return;
  uiReadyArmed = false;
  uiReadyPlayed = true;
  sfx.unlock();
  void sfx.play("ui_ready");
}, { capture: true, passive: true });

/* 收到消息的"提示音"与"聊天里的落地音"互斥：同一个新消息不响两次 */
let lastMsgSoundAt = 0;
function playMsgIn(opts = {}) {
  lastMsgSoundAt = performance.now();
  // 窗口在托盘/最小化时不响：后台的提醒交给桌面壳的无声提示窗（不发系统通知、不播放 Windows 音效）
  if (document.hidden) return;
  void sfx.play("ui_msg_in", opts);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function icon(name, cls = "") {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function peerAgentsVisible(nodeId) {
  try {
    return (JSON.parse(localStorage.getItem("vrlink.peerAgents") || "[]") || []).includes(nodeId);
  } catch {
    return false;
  }
}

function setPeerAgentsVisible(nodeId, visible) {
  try {
    const set = new Set(JSON.parse(localStorage.getItem("vrlink.peerAgents") || "[]") || []);
    if (visible) set.add(nodeId);
    else set.delete(nodeId);
    localStorage.setItem("vrlink.peerAgents", JSON.stringify([...set]));
  } catch {
    /* 忽略 */
  }
}

function profileState() {
  try {
    return JSON.parse(localStorage.getItem("vrlink.profile") || "{}") || {};
  } catch {
    return {};
  }
}

function setProfile(profile) {
  try {
    localStorage.setItem("vrlink.profile", JSON.stringify(profile));
  } catch {
    /* 私密模式忽略 */
  }
}

/* 扫一扫：玩家可随时关掉（本机设置，存在 localStorage；关掉后「＋」里不再出现入口） */
const SCAN_ENABLED_KEY = "vrlink.scan.enabled";

function scanEnabled() {
  try {
    return localStorage.getItem(SCAN_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function setScanEnabled(value) {
  try {
    localStorage.setItem(SCAN_ENABLED_KEY, value ? "1" : "0");
  } catch {
    /* 私密模式忽略 */
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const pad2 = (n) => String(n).padStart(2, "0");

function toMs(at) {
  if (at == null || at === "") return 0;
  if (typeof at === "number") return at;
  const num = Number(at);
  if (Number.isFinite(num)) return num;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtListTime(at) {
  const ms = toMs(at);
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨天";
  if (now.getTime() - ms < 6 * 86400000) return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function fmtChatTime(at) {
  const ms = toMs(at);
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${pad2(d.getMonth() + 1)}月${pad2(d.getDate())}日 ${hm}`;
}

function fmtStamp(at) {
  const ms = toMs(at);
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDateOnly(at) {
  const ms = toMs(at);
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function shortText(text, max = 42) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function initialOf(name) {
  const text = String(name ?? "").trim();
  if (!text) return "?";
  const first = [...text][0];
  return first || "?";
}

/** 头像文字：优先用名片里自己设置的头像，没设置才取名字首字。 */
function avatarTextOf(name, explicit = "") {
  const chosen = String(explicit ?? "").trim();
  if (chosen) return [...chosen].slice(0, 2).join("");
  return initialOf(String(name ?? ""));
}

function avatarHtml(name, { cls = "", online = false, text = "", data = "" } = {}) {
  const dot = online ? '<i class="online-dot"></i>' : "";
  const image = typeof data === "string" && data.startsWith("data:image/")
    ? `<img class="avatar-img" src="${escapeHtml(data)}" alt="" />`
    : escapeHtml(avatarTextOf(name, text));
  return `<span class="avatar ${cls}">${image}${dot}</span>`;
}

function briefId(nodeId) {
  const text = String(nodeId ?? "");
  const tail = text.split(":").pop() || text;
  return tail.length > 12 ? `${tail.slice(0, 6)}…${tail.slice(-4)}` : tail;
}

/**
 * 好友的显示名：玩家自己起的名字优先（改名即时生效）；没有名字才用节点短码兜底，
 * 不再加任何前缀 —— 名字就是名字，身份码只做兜底。
 */
function peerDisplayName(name, nodeId, fallback = "") {
  const text = String(name ?? "").trim();
  if (text && text !== "我" && !/^\u9c7c\u53cb\s*/.test(text)) return text;
  const brief = nodeId ? briefId(nodeId) : "";
  return brief || fallback;
}

/** 自己的显示名（聊天里"我"这一侧用）。 */
function selfDisplayName(selfCard = null) {
  const cardName = String(selfCard?.name ?? "").trim();
  if (cardName && cardName !== "我") return cardName;
  const profileName = String(profileState().name ?? "").trim();
  return profileName || "我";
}

function errorText(error) {
  const message = String(error?.message ?? error ?? "");
  if (!message) return "未知错误";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "网络连接失败，请检查 Hub 是否在运行";
  return message;
}

/* ======================================================================
 * 1. 状态 / 缓存
 * ==================================================================== */

const cache = {
  conversations: null,
  status: null,
  pending: null,
  groups: null,
  postcards: null,
  devices: null,
  plugins: null,
  identity: null,
  health: null,
  safeMode: null,
  guests: null,
  humanThreads: null,
  humanSelf: null,
};

const ui = {
  dir: "none",
  route: null,
  chain: [],
  scroll: {},
  searchOpen: false,
  searchQuery: "",
  drafts: {},
  deviceChar: "",
  deviceValue: "",
  connectResult: null,
  bootAt: Date.now(),
};

function isDesktop() {
  return window.matchMedia("(min-width: 900px)").matches;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const READ_KEY = "vrlink.wx.read";
let readMap = loadJSON(READ_KEY, {});
function markRead(characterId, at = Date.now()) {
  readMap = { ...readMap, [characterId]: at };
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(readMap));
  } catch {
    /* ignore */
  }
  cache.conversations = null;
  ui.listRefresh?.(); // 红点即时消失，不等下一轮列表刷新
}
function unreadOf(conversation) {
  const last = conversation?.last;
  const lastAt = toMs(last?.at);
  const seen = Number(readMap[conversation?.characterId] ?? 0);
  if (last && !last.fromSelf && lastAt > seen) return 1;
  return Number(conversation?.unread ?? 0) || 0;
}

/* ======================================================================
 * 2. API
 * ==================================================================== */

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

const loaders = {
  async conversations(force = false) {
    if (!force && cache.conversations) return cache.conversations;
    const data = await api("/api/conversations");
    cache.conversations = data.conversations ?? [];
    return cache.conversations;
  },
  async status(force = false) {
    if (!force && cache.status) return cache.status;
    const data = await api("/api/federation/status");
    cache.status = { federation: data.federation ?? {}, peers: data.peers ?? [] };
    return cache.status;
  },
  async pending(force = false) {
    if (!force && cache.pending) return cache.pending;
    const data = await api("/api/federation/pending");
    cache.pending = data.pending ?? [];
    return cache.pending;
  },
  async groups(force = false) {
    if (!force && cache.groups) return cache.groups;
    const data = await api("/api/federation/groups");
    cache.groups = data.groups ?? [];
    return cache.groups;
  },
  async postcards(force = false) {
    if (!force && cache.postcards) return cache.postcards;
    const data = await api("/api/federation/postcards");
    cache.postcards = data.postcards ?? [];
    return cache.postcards;
  },
  async devices(force = false) {
    if (!force && cache.devices) return cache.devices;
    const data = await api("/api/devices");
    cache.devices = data.devices ?? [];
    return cache.devices;
  },
  async plugins(force = false) {
    if (!force && cache.plugins) return cache.plugins;
    const data = await api("/api/plugins");
    cache.plugins = data.plugins ?? [];
    return cache.plugins;
  },
  async identity(force = false) {
    if (!force && cache.identity) return cache.identity;
    const data = await api("/api/identity");
    cache.identity = data.node ?? null;
    return cache.identity;
  },
  async health(force = false) {
    if (!force && cache.health) return cache.health;
    cache.health = await api("/api/health");
    return cache.health;
  },
  async safeMode(force = false) {
    if (!force && cache.safeMode !== null) return cache.safeMode;
    const data = await api("/api/safe-mode");
    cache.safeMode = Boolean(data.safeMode);
    return cache.safeMode;
  },
  async guests(force = false) {
    if (!force && cache.guests) return cache.guests;
    const data = await api("/api/guest-tokens");
    cache.guests = data.tokens ?? [];
    return cache.guests;
  },
  /** 人-人线程（好友对话）；和 Agent 的会话不是一回事。 */
  async humanThreads(force = false) {
    if (!force && cache.humanThreads) return cache.humanThreads;
    const data = await api("/api/human/threads");
    cache.humanThreads = data.threads ?? [];
    return cache.humanThreads;
  },
  async humanSelf(force = false) {
    if (!force && cache.humanSelf) return cache.humanSelf;
    const data = await api("/api/human/self");
    cache.humanSelf = data.self ?? null;
    return cache.humanSelf;
  },
};

/* ======================================================================
 * 3. 路由（hash + history）
 * ==================================================================== */

const TAB_DEFS = [
  { id: "messages", label: "消息", icon: "chat", path: "#/messages" },
  { id: "contacts", label: "通讯录", icon: "contacts", path: "#/contacts" },
  { id: "discover", label: "发现", icon: "compass", path: "#/discover" },
  { id: "me", label: "我", icon: "me", path: "#/me" },
];

const ROUTE_DEFS = {
  messages: { tab: "messages", title: "消息" },
  chat: { tab: "messages", title: "聊天" },
  fish: { tab: "messages", title: "资料" },
  new: { tab: "messages", title: "新建 Agent" },
  contacts: { tab: "contacts", title: "通讯录" },
  pending: { tab: "contacts", title: "新的朋友" },
  peer: { tab: "contacts", title: "好友" },
  groups: { tab: "contacts", title: "群聊" },
  group: { tab: "contacts", title: "群聊" },
  invite: { tab: "contacts", title: "邀请朋友" },
  guest: { tab: "contacts", title: "只读访客" },
  postcards: { tab: "contacts", title: "明信片" },
  discover: { tab: "discover", title: "发现" },
  devices: { tab: "discover", title: "设备" },
  plugins: { tab: "discover", title: "插件" },
  plugin: { tab: "discover", title: "插件详情" },
  me: { tab: "me", title: "我" },
  identity: { tab: "me", title: "节点身份" },
  safe: { tab: "me", title: "安全模式" },
  backup: { tab: "me", title: "备份与恢复" },
  version: { tab: "me", title: "版本与发行版" },
  advanced: { tab: "me", title: "高级" },
};

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parseRoute(hash = location.hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const seg = pathPart.split("/").filter(Boolean).map(decodePart);
  const query = new URLSearchParams(queryPart ?? "");
  const a = seg[0] ?? "";
  const b = seg[1] ?? "";
  const c = seg[2] ?? "";

  if (!a || a === "messages") return { kind: "messages" };
  if (a === "chat" && b) return { kind: "chat", id: b };
  if (a === "group" && b) return { kind: "group", id: b };
  if (a === "remote" && b) return { kind: "remote", nodeId: b, char: c || "" };
  if (a === "fish" && b) return { kind: "fish", id: b, from: query.get("from") === "chat" ? "chat" : "" };
  if (a === "new") return { kind: "new" };

  if (a === "contacts") {
    if (b === "pending") return { kind: "pending" };
    if (b === "peer" && c) return { kind: "peer", nodeId: c };
    if (b === "groups") return c ? { kind: "group", id: c } : { kind: "groups" };
    if (b === "invite") return { kind: "invite" };
    if (b === "guest") return { kind: "guest" };
    if (b === "postcards") return { kind: "postcards" };
    return { kind: "contacts" };
  }

  if (a === "discover") {
    if (b === "devices") return { kind: "devices" };
    if (b === "plugins") return c ? { kind: "plugin", id: c } : { kind: "plugins" };
    return { kind: "discover" };
  }

  if (a === "me") {
    if (b === "identity") return { kind: "identity" };
    if (b === "safe-mode") return { kind: "safe" };
    if (b === "backup") return { kind: "backup" };
    if (b === "version") return { kind: "version" };
    if (b === "advanced") return { kind: "advanced" };
    return { kind: "me" };
  }

  return { kind: "messages" };
}

function routePath(route) {
  const enc = encodeURIComponent;
  switch (route.kind) {
    case "messages": return "#/messages";
    case "chat": return `#/chat/${enc(route.id)}`;
    case "fish": return `#/fish/${enc(route.id)}${route.from === "chat" ? "?from=chat" : ""}`;
    case "new": return "#/new";
    case "contacts": return "#/contacts";
    case "pending": return "#/contacts/pending";
    case "peer": return `#/contacts/peer/${enc(route.nodeId)}`;
    case "groups": return "#/contacts/groups";
    case "group": return `#/contacts/groups/${enc(route.id)}`;
    case "invite": return "#/contacts/invite";
    case "guest": return "#/contacts/guest";
    case "postcards": return "#/contacts/postcards";
    case "discover": return "#/discover";
    case "devices": return "#/discover/devices";
    case "plugins": return "#/discover/plugins";
    case "plugin": return `#/discover/plugins/${enc(route.id)}`;
    case "me": return "#/me";
    case "identity": return "#/me/identity";
    case "safe": return "#/me/safe-mode";
    case "backup": return "#/me/backup";
    case "version": return "#/me/version";
    case "advanced": return "#/me/advanced";
    default: return "#/messages";
  }
}

function parentRoute(route) {
  switch (route.kind) {
    case "messages": case "contacts": case "discover": case "me":
      return null;
    case "chat": case "new": return { kind: "messages" };
    case "fish": return route.from === "chat" ? { kind: "chat", id: route.id } : { kind: "messages" };
    case "pending": case "peer": case "groups": case "invite": case "guest": case "postcards":
      return { kind: "contacts" };
    case "group": return { kind: "messages" };
    case "remote": return { kind: "messages" };
    case "devices": case "plugins": return { kind: "discover" };
    case "plugin": return { kind: "plugins" };
    case "identity": case "safe": case "backup": case "version": case "advanced":
      return { kind: "me" };
    default: return { kind: "messages" };
  }
}

function buildChain(route) {
  const chain = [route];
  let cursor = route;
  for (let guard = 0; guard < 8; guard += 1) {
    const parent = parentRoute(cursor);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent;
  }
  return chain;
}

function baseTabOf(route) {
  return ROUTE_DEFS[route.kind]?.tab ?? "messages";
}

function navigate(target, { replace = false } = {}) {
  const path = typeof target === "string"
    ? (target.startsWith("#") ? target : `#${target.startsWith("/") ? "" : "/"}${target}`)
    : routePath(target);
  if (path === location.hash) {
    render();
    return;
  }
  ui.dir = "forward";
  const depth = buildChain(parseRoute(path)).length;
  const nextState = { wx: true, wxDepth: depth, wxDirect: false };
  if (replace) history.replaceState(nextState, "", path);
  else history.pushState(nextState, "", path);
  render();
}

function goBack() {
  const route = ui.route ?? parseRoute();
  const parent = parentRoute(route);
  if (!parent) return;
  const currentState = history.state ?? {};
  ui.dir = "back";
  if (currentState.wxDirect) {
    const path = routePath(parent);
    history.replaceState({ wx: true, wxDepth: buildChain(parent).length, wxDirect: false }, "", path);
    render();
  } else if (history.length > 1) {
    history.back();
  } else {
    const path = routePath(parent);
    history.replaceState({ wx: true, wxDepth: buildChain(parent).length, wxDirect: false }, "", path);
    render();
  }
}

/* ======================================================================
 * 4. 反馈组件：toast / sheet / confirm
 * ==================================================================== */

function toast(message, kind = "") {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = String(message ?? "");
  host.append(el);
  if (kind === "error") void sfx.play("ui_error", { minGap: 0.35 });
  setTimeout(() => el.remove(), 3200);
}

function closeLayers() {
  stopScanner();
  if (netUI.open) {
    netUI.open = false;
    stopNetPoll();
  }
  const host = $("#layers");
  if (host) host.innerHTML = "";
}

function openSheet({ title = "", body = "", onMount = null, onClose = null } = {}) {
  closeLayers();
  const host = $("#layers");
  const wrap = document.createElement("div");
  wrap.className = "backdrop";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    ${title ? `<div class="sheet-title">${escapeHtml(title)}</div>` : ""}
    <div class="sheet-body"></div>
  </div>`;
  const bodyEl = $(".sheet-body", wrap);
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  wrap.addEventListener("click", (event) => {
    if (event.target === wrap) close();
  });
  document.addEventListener("keydown", onKey);
  host.append(wrap);
  onMount?.({ wrap, body: bodyEl, close });
  return { wrap, body: bodyEl, close };
}

/* ======================================================================
 * 扫一扫：相机取流 + jsQR 解码 → 识别邀请 → 直接发好友申请
 * ==================================================================== */

let scanState = null; // { stream, timer, stopped }
let scanFacing = "environment"; // environment = 后置（扫别人的屏），user = 前置

function stopScanner() {
  if (!scanState) return;
  scanState.stopped = true;
  if (scanState.timer) clearTimeout(scanState.timer);
  try {
    scanState.stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
  scanState = null;
}

function scanSay(statusEl, text, kind = "") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `scan-hint${kind ? ` ${kind}` : ""}`;
}

async function startScanner(body) {
  const video = $('[data-role="scan-video"]', body);
  const statusEl = $('[data-role="scan-status"]', body);
  const canvas = $('[data-role="scan-canvas"]', body);
  if (!scanEnabled()) {
    scanSay(statusEl, "扫一扫已被你关掉：我 → 扫一扫 可以重新打开", "warn");
    return;
  }
  if (!window.isSecureContext) {
    scanSay(statusEl, "相机只在 https 或本机地址下可用；可以改用下面的粘贴框", "warn");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    scanSay(statusEl, "这个环境拿不到相机；可以改用下面的粘贴框", "warn");
    return;
  }
  if (typeof window.jsQR !== "function") {
    scanSay(statusEl, "扫码组件没加载；可以改用下面的粘贴框", "warn");
    return;
  }
  scanSay(statusEl, "正在打开相机…");
  // 先要后置（扫别人屏幕），拿不到就退到"任意能用的镜头"
  const attempts = [
    { video: { facingMode: { exact: scanFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: { ideal: scanFacing } }, audio: false },
    { video: true, audio: false },
  ];
  let stream = null;
  let lastError = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (error) {
      lastError = error;
      if (String(error?.name ?? "") === "NotAllowedError") break; // 用户拒绝就不要继续缠着要
    }
  }
  try {
    if (!stream) throw lastError ?? new Error("没有可用的摄像头");
    if (!document.body.contains(video)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    scanState = { stream, timer: null, stopped: false };
    video.srcObject = stream;
    video.setAttribute("playsinline", "true");
    await video.play().catch(() => {});
    const label = String(stream.getVideoTracks?.()[0]?.label ?? "").trim();
    scanSay(statusEl, label ? `把二维码放进框里（${label}）` : "把对方的邀请二维码放进框里");
  } catch (error) {
    const name = String(error?.name ?? "");
    const reason = name === "NotAllowedError"
      ? "相机权限被拒绝"
      : name === "NotFoundError"
        ? "没找到摄像头"
        : String(error?.message ?? error);
    scanSay(statusEl, `打不开相机：${reason}。可以改用下面的粘贴框`, "warn");
    return;
  }

  const tick = () => {
    if (!scanState || scanState.stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && canvas) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, width, height);
        const image = ctx.getImageData(0, 0, width, height);
        const found = window.jsQR(image.data, width, height, { inversionAttempts: "attemptBoth" });
        if (found?.data) {
          stopScanner();
          showScannedInvite(found.data);
          return;
        }
      }
    } catch {
      /* 单帧解码失败就继续 */
    }
    scanState.timer = setTimeout(tick, 140);
  };
  tick();
}

function openScanner() {
  if (!scanEnabled()) {
    toast("扫一扫已关掉：我 → 扫一扫 可以打开", "error");
    return;
  }
  openSheet({
    title: "扫一扫",
    body: `<div class="scan-wrap">
        <video class="scan-video" data-role="scan-video" playsinline muted autoplay></video>
        <div class="scan-frame" aria-hidden="true"></div>
        <div class="scan-hint" data-role="scan-status">把对方的邀请二维码放进框里</div>
        <button class="scan-flip" type="button" data-act="scan-flip" aria-label="换镜头">换镜头</button>
      </div>
      <canvas class="hidden" data-role="scan-canvas"></canvas>
      <div class="section-title" style="padding-left:0">扫不了？手动粘链接</div>
      <div class="field">
        <input data-role="scan-manual" placeholder="vrlink://connect?..." aria-label="邀请链接" />
        <div class="hint">对方在「通讯录 → 邀请朋友」里复制的链接。</div>
      </div>
      <button class="btn primary block" type="button" data-act="scan-manual-go">用这段链接加好友</button>
      <button class="sheet-row sheet-cancel" type="button" data-act="close-layers">取消</button>`,
    onMount: ({ body }) => {
      startScanner(body);
    },
  });
}

async function showScannedInvite(rawText) {
  const text = String(rawText ?? "").trim();
  let parsed = null;
  let bad = "";
  try {
    const data = await api("/api/federation/invite/parse", {
      method: "POST",
      body: JSON.stringify({ invite: text }),
    });
    parsed = { ...data.invite, known: Boolean(data.known) };
  } catch (error) {
    bad = error.code === "BAD_INVITE" || error.status === 400
      ? "这不是 VRlink 的邀请码（要 vrlink://connect?… 开头）"
      : errorText(error);
  }
  const hints = (parsed?.hints ?? []).map((hint) => `${hint.host}:${hint.port}`).join(" · ");
  openSheet({
    title: parsed ? "扫到了邀请" : "无法识别",
    body: `<div class="card" style="margin:8px 0">
      ${parsed
        ? `<h3>${escapeHtml(parsed.name || "对方节点")}</h3>
           <p class="mono">${escapeHtml(parsed.nodeId || "（链接里没有 nodeId）")}</p>
           <p class="muted" style="margin-top:6px">地址 ${escapeHtml(hints || "—")}</p>
           ${parsed.known ? '<p style="margin-top:8px;color:var(--accent)">你们已经是好友了。</p>' : ""}`
        : `<p class="muted">${escapeHtml(bad || "这不是 VRlink 的邀请码")}</p>`}
      <div class="actions" style="margin-top:12px">
        ${parsed && !parsed.known
          ? `<button class="btn primary" type="button" data-act="scan-send" data-text="${escapeHtml(text)}">发送好友申请</button>`
          : ""}
        <button class="btn ghost" type="button" data-act="scan-open">重新扫</button>
      </div>
      <div class="scan-progress" data-role="scan-progress"></div>
      <p class="hint" style="margin-top:10px">扫到你屏幕上的二维码，等于当面拿到地址；对方还需要在「新的朋友」里确认同一组数字才算加成功。</p>
    </div>`,
  });
}

function friendRequestError(state) {
  const code = String(state?.code ?? "");
  const detail = String(state?.error ?? "");
  if (code === "PEER_BLOCKED") return "对方撤销过这台机器，需要对方先在「新的朋友」里处理。";
  if (code === "PAIR_REJECTED") return "对方拒绝了这次申请。";
  if (/timeout/i.test(detail)) return "对方在 3 分钟内没有确认。可以重扫，或让对方在「新的朋友」里点接受。";
  if (code === "CONNECT_FAILED" || /all hints failed|connect timeout|ECONNREFUSED/i.test(detail)) {
    return "连不上对方：确认两台机器在同一 Wi-Fi / Tailscale，对方开了「一键组网」，并且防火墙没拦 5275。";
  }
  return detail || "连接失败，稍后再试。";
}

async function sendFriendRequestFromScan(el) {
  const text = String(el.dataset.text ?? "").trim();
  if (!text) return;
  const sheetBody = el.closest(".sheet-body") ?? document;
  const progress = $('[data-role="scan-progress"]', sheetBody);
  const setProgress = (html) => {
    if (progress) progress.innerHTML = html;
  };
  el.disabled = true;
  setProgress('<p class="muted">正在发送好友申请…</p>');
  try {
    const started = await api("/api/federation/connect", {
      method: "POST",
      body: JSON.stringify({ invite: text, autoConfirm: true, async: true }),
    });
    const attempt = started.attempt ?? {};
    setProgress('<p class="muted">已发出好友申请，等对方在「新的朋友」里确认同一组数字（最多 3 分钟）…</p>');
    const deadline = Date.now() + 185000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const data = await api(`/api/federation/connect/attempt?id=${encodeURIComponent(attempt.id ?? "")}`);
      const state = data.attempt ?? {};
      if (state.state === "ok") {
        cache.status = null;
        cache.pending = null;
        closeLayers();
        toast(`已和 ${state.peer?.name || "对方"} 成为好友`);
        render();
        navigate({ kind: "peer", nodeId: state.peer?.nodeId ?? "" });
        return;
      }
      if (state.state === "error") throw new Error(friendRequestError(state));
    }
    throw new Error(friendRequestError({ code: "TIMEOUT", error: "frame read timeout" }));
  } catch (error) {
    setProgress(`<p class="muted" style="color:var(--danger)">${escapeHtml(errorText(error))}</p>`);
    el.disabled = false;
  }
}

function confirmDialog({ title, text, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    closeLayers();
    const host = $("#layers");
    const wrap = document.createElement("div");
    wrap.className = "backdrop modal";
    wrap.innerHTML = `<div class="modal-card" role="alertdialog" aria-modal="true">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-role="cancel">取消</button>
        <button class="btn ${danger ? "danger" : "primary"}" type="button" data-role="ok">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
    const done = (value) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") done(false);
    };
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) done(false);
    });
    $('[data-role="cancel"]', wrap).addEventListener("click", () => done(false));
    $('[data-role="ok"]', wrap).addEventListener("click", () => done(true));
    document.addEventListener("keydown", onKey);
    host.append(wrap);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ""));
    toast("已复制");
  } catch {
    const area = document.createElement("textarea");
    area.value = String(text ?? "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("已复制");
    } catch {
      toast("复制失败，请手动选择", "error");
    }
    area.remove();
  }
}

/* ======================================================================
 * 5. 通用片段
 * ==================================================================== */

function skeletonList(count = 6) {
  const row = `<div class="skel-row"><div class="skel-avatar"></div><div class="skel-lines"><div class="skel-line w40"></div><div class="skel-line w60"></div></div></div>`;
  return `<div class="skeleton" aria-busy="true" aria-label="正在加载">${row.repeat(count)}</div>`;
}

function emptyState({ iconName = "info", title, hint = "", action = "" }) {
  return `<div class="state">
    ${icon(iconName)}
    <div class="state-title">${escapeHtml(title)}</div>
    ${hint ? `<div class="state-hint">${escapeHtml(hint)}</div>` : ""}
    ${action}
  </div>`;
}

function errorState(message, key, title = "加载失败") {
  return `<div class="state error">
    ${icon("x")}
    <div class="state-title">${escapeHtml(title)}</div>
    <div class="state-hint">${escapeHtml(message)}</div>
    <button class="btn ghost" type="button" data-act="retry" data-key="${escapeHtml(key)}">重试</button>
  </div>`;
}

function kv(k, v) {
  return `<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${v}</span></div>`;
}

function copyButton(text, label = "复制") {
  return `<button class="btn ghost sm" type="button" data-act="copy" data-text="${escapeHtml(text)}">${label}</button>`;
}

function switchButton(act, on, { id = "", label = "" } = {}) {
  return `<button class="switch ${on ? "on" : ""}" type="button" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${escapeHtml(label || act)}" data-act="${act}" ${id ? `data-id="${escapeHtml(id)}"` : ""}></button>`;
}

/* ======================================================================
 * 6. 布局渲染：rail / tabbar / push 栈
 * ==================================================================== */

const hostSeq = new WeakMap();

function badgeHtml(count, { dot = false } = {}) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  if (dot) return '<span class="badge dot"></span>';
  return `<span class="badge">${n > 99 ? "99+" : n}</span>`;
}

function unreadTotal() {
  const list = cache.conversations ?? [];
  return list.reduce((sum, item) => sum + (unreadOf(item) > 0 ? 1 : 0), 0);
}

function lanState() {
  const listening = cache.status?.federation?.listening;
  return {
    enabled: listening?.host === "0.0.0.0",
    host: listening?.host ?? "127.0.0.1",
    port: listening?.port ?? 5275,
  };
}

function renderRail(activeTab) {
  const rail = $("#rail");
  if (!rail) return;
  const unread = unreadTotal();
  const pendingCount = cache.pending?.length ?? 0;
  const lan = lanState();
  const selfCard = cache.humanSelf ?? null;
  const who = String(selfCard?.name ?? "").trim() || cache.identity?.fingerprint || "我";
  const avatarText = String(selfCard?.avatarText ?? "").trim() || who;
  const avatarData = String(selfCard?.avatarData ?? "").trim();
  const railHtml = `
    <button class="rail-avatar" type="button" data-go="#/me" aria-label="我" title="${escapeHtml(who)}">
      ${avatarHtml(who, { cls: "rail-face", text: avatarText, data: avatarData })}
    </button>
    ${TAB_DEFS.map((tab) => {
      const badge = tab.id === "messages" ? badgeHtml(unread) : tab.id === "contacts" ? badgeHtml(pendingCount) : "";
      return `<button class="rail-item ${tab.id === activeTab ? "on" : ""}" type="button" data-go="${tab.path}" aria-label="${tab.label}">
        ${icon(tab.icon)}<span>${tab.label}</span>${badge}
      </button>`;
    }).join("")}
    <div class="rail-spacer"></div>
    <button class="rail-net ${lan.enabled ? "on" : ""}" type="button" data-act="open-network" aria-label="一键组网" title="一键组网">
      ${icon("wifi")}<span>一键组网</span>${lan.enabled ? '<i class="net-dot" aria-hidden="true"></i>' : ""}
    </button>`;
  if (rail.dataset.html !== railHtml) {
    rail.innerHTML = railHtml;
    rail.dataset.html = railHtml;
  }
}

function renderTabbar(activeTab) {
  const tabbar = $("#tabbar");
  if (!tabbar) return;
  const unread = unreadTotal();
  const pendingCount = cache.pending?.length ?? 0;
  const tabHtml = TAB_DEFS.map((tab) => {
    const badge = tab.id === "messages" ? badgeHtml(unread) : tab.id === "contacts" ? badgeHtml(pendingCount) : "";
    return `<button class="tabbar-item ${tab.id === activeTab ? "on" : ""}" type="button" data-go="${tab.path}" aria-current="${tab.id === activeTab ? "page" : "false"}">
      ${icon(tab.icon)}<span>${tab.label}</span>${badge}
    </button>`;
  }).join("");
  if (tabbar.dataset.html !== tabHtml) {
    tabbar.innerHTML = tabHtml;
    tabbar.dataset.html = tabHtml;
  }
}

function navbarRight(route) {
  switch (route.kind) {
    case "messages":
      return `<button class="icon-btn" type="button" data-act="toggle-search" aria-label="搜索">${icon("search")}</button>
        <button class="icon-btn" type="button" data-act="compose-menu" aria-label="新建">${icon("plus")}</button>
        <button class="icon-btn" type="button" data-act="open-settings" aria-label="设置">${icon("gear")}</button>`;
    case "contacts":
      return `<button class="icon-btn" type="button" data-act="contacts-add" aria-label="添加">${icon("plus")}</button>`;
    case "groups":
      return `<button class="icon-btn" type="button" data-act="new-group" aria-label="新建群聊">${icon("plus")}</button>`;
    case "chat":
      return `<button class="icon-btn" type="button" data-act="chat-menu" data-id="${escapeHtml(route.id)}" aria-label="更多">${icon("more")}</button>`;
    case "group":
      return `<button class="icon-btn" type="button" data-act="group-menu" data-id="${escapeHtml(route.id)}" aria-label="更多">${icon("more")}</button>`;
    case "guest":
      return `<button class="icon-btn" type="button" data-act="guest-create" aria-label="新建访客链接">${icon("plus")}</button>`;
    case "postcards":
      return `<button class="icon-btn" type="button" data-act="postcard-create" aria-label="写一张">${icon("plus")}</button>`;
    case "plugins":
      return `<button class="icon-btn" type="button" data-act="reload" data-key="plugins" aria-label="刷新">${icon("refresh")}</button>`;
    case "devices":
      return `<button class="icon-btn" type="button" data-act="reload" data-key="devices" aria-label="刷新">${icon("refresh")}</button>`;
    case "fish":
      return `<button class="icon-btn" type="button" data-act="fish-menu" data-id="${escapeHtml(route.id)}" aria-label="更多">${icon("more")}</button>`;
    default:
      return "";
  }
}

const ROOT_TAB_KINDS = new Set(["messages", "contacts", "discover", "me"]);

function screenShell(route, def, { showBack, role }) {
  const title = typeof def.title === "function" ? def.title(route) : def.title;
  return `<section class="screen ${def.chat ? "chat" : ""}" data-kind="${route.kind}" data-role="${role}" aria-label="${escapeHtml(title)}">
    <header class="navbar">
      ${showBack
        ? `<div class="navbar-side left"><button class="icon-btn" type="button" data-back aria-label="返回">${icon("back")}</button></div>`
        : ""}
      <h1 class="navbar-title" data-title>${escapeHtml(title)}</h1>
      <div class="navbar-side">${def.plainNav ? "" : navbarRight(route)}</div>
    </header>
    <div class="screen-body ${def.chat ? "chat-scroll" : ""}" data-body></div>
    ${def.chat ? composerHtml(route, def) : ""}
  </section>`;
}

function composerHtml(route, def) {
  if (def.composer === "remote") {
    // 好友聊天固定走人-人通道（不再提供"对方本人 / 对方的 Agent"的切换）
    return `<form class="composer" data-form="human-chat" data-node="${escapeHtml(route.nodeId ?? "")}">
      <textarea name="text" rows="1" placeholder="发消息给好友…" aria-label="消息输入框" enterkeyhint="send"></textarea>
      <button class="send-btn" type="submit" aria-label="发送">${icon("send")}</button>
    </form>`;
  }
  const isGroup = def.composer === "group";
  const key = isGroup ? `group:${route.id}` : route.id;
  const draft = ui.drafts[key] ?? "";
  return `<form class="composer" data-form="${isGroup ? "group-chat" : "chat"}" data-id="${escapeHtml(route.id)}">
    <textarea name="text" rows="1" placeholder="${isGroup ? "发消息给群成员…" : "发消息…"}" aria-label="消息输入框" enterkeyhint="send">${escapeHtml(draft)}</textarea>
    <button class="send-btn ${draft.trim() ? "can-send" : ""}" type="submit" aria-label="发送">${icon("send")}</button>
  </form>`;
}

const hostMounts = new Map(); // host -> { key, ctx }

function mountScreen(host, route, role) {
  const def = SCREEN_DEFS[route.kind] ?? SCREEN_DEFS.messages;
  // 同一个 host 上如果已经挂着同一路由，就不要再拆了重建：
  // 每次点击都 innerHTML 重建整页，WebView 会闪一下（BOSS 2026-11-18 反馈）。
  // 用路由对象本身当 key：routePath() 漏掉 remote 会让所有人-人聊天共用同一个 key，
  // 切换聊天时被当成“已在页面上”直接跳过（2026-11-18 实测：桌面端点不开笔记本端的对话）。
  const mountKey = `${role}|${route.kind}|${JSON.stringify(route)}`;
  const mounted = hostMounts.get(host);
  if (mounted && mounted.key === mountKey && host.firstElementChild) {
    return mounted.ctx;
  }
  const seq = (hostSeq.get(host) ?? 0) + 1;
  hostSeq.set(host, seq);
  const showBack = role !== "list" && !ROOT_TAB_KINDS.has(route.kind);
  host.innerHTML = screenShell(route, def, { showBack, role });
  const screenEl = host.firstElementChild;
  if (role === "stack" && ui.dir === "forward") screenEl.classList.add("anim-push-in");
  if (role === "list" && ui.dir === "back" && !isDesktop()) screenEl.classList.add("anim-back-in");
  const bodyEl = $("[data-body]", screenEl);
  const key = routePath(route);
  bodyEl.dataset.key = key;
  const ctx = {
    role,
    screenEl,
    bodyEl,
    key,
    alive: () => hostSeq.get(host) === seq,
    setTitle(text, sub = "") {
      const titleEl = $("[data-title]", screenEl);
      if (!titleEl) return;
      titleEl.textContent = text;
      if (sub) {
        const subEl = document.createElement("span");
        subEl.className = "navbar-sub";
        subEl.textContent = sub;
        titleEl.append(subEl);
      }
    },
    scrollToBottom() {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    },
    restoreScroll() {
      const saved = ui.scroll[key];
      if (typeof saved === "number") bodyEl.scrollTop = saved;
    },
  };
  def.body(route, bodyEl, ctx).catch((error) => {
    if (!ctx.alive()) return;
    bodyEl.innerHTML = errorState(errorText(error), `${route.kind}:${route.id ?? route.nodeId ?? ""}`);
  });
  hostMounts.set(host, { key: mountKey, ctx });
  return ctx;
}


let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    render();
  });
}

function render() {
  const route = parseRoute();
  ui.route = route;
  const chain = buildChain(route);
  ui.chain = chain;
  const activeTab = baseTabOf(route);
  const desktop = isDesktop();

  renderRail(activeTab);
  renderTabbar(activeTab);

  const listRoute = desktop && chain.length > 1 ? chain[chain.length - 2] : chain[0];
  mountScreen($("#listcol"), listRoute, "list");

  const content = $("#content");
  const stack = $("#stack");
  if (desktop) {
    stack.innerHTML = "";
    if (chain.length > 1) mountScreen(content, chain[chain.length - 1], "content");
    else {
      // v0.5.1：空聊天不再放水印，保持纯深色背景（BOSS 2026-11-18 决定）
      content.innerHTML = "";
      hostMounts.delete(content);
    }
  } else {
    content.innerHTML = "";
    if (chain.length > 1) mountScreen(stack, chain[chain.length - 1], "stack");
    else stack.innerHTML = "";
  }

  history.replaceState(
    { ...(history.state ?? { wx: true, wxDirect: true }), wxDepth: chain.length },
    "",
    location.hash || "#/messages",
  );
  ui.dir = "none";
}

/* ======================================================================
 * 7. 聊天数据
 * ==================================================================== */

const chats = new Map();

function getChat(id) {
  if (!chats.has(id)) {
    chats.set(id, {
      messages: [],
      loading: true,
      loaded: false,
      error: null,
      pending: false,
      sending: false,
      meta: null,
      state: null,
    });
  }
  return chats.get(id);
}

function eventsToMessages(events) {
  const messages = [];
  for (const event of events ?? []) {
    const text = String(event?.content?.text ?? "");
    if (!text) continue;
    if (event.type === "message.sent") {
      messages.push({ side: "in", text, at: event.at });
    } else if (event.type === "message.received") {
      const actorId = event?.source?.actor?.id ?? "";
      const thread = event?.source?.thread ?? "";
      const body = event?.source?.body ?? "";
      if (actorId === "owner" || thread === "main" || body === "desktop") {
        messages.push({ side: "out", text, at: event.at });
      }
    }
  }
  return messages;
}

async function loadChat(id, force = false) {
  const store = getChat(id);
  if (store.loaded && !force) return store;
  store.loading = true;
  store.error = null;
  try {
    const [characterData, eventsData] = await Promise.all([
      api(`/api/characters/${encodeURIComponent(id)}`),
      api(`/api/characters/${encodeURIComponent(id)}/events?limit=60`),
    ]);
    store.meta = characterData.character ?? null;
    store.state = characterData.state ?? null;
    store.messages = eventsToMessages(eventsData.events ?? []);
    store.loaded = true;
    store.loading = false;
    markRead(id, Date.now());
  } catch (error) {
    store.loading = false;
    store.error = errorText(error);
  }
  return store;
}

function renderChatMessages(store, chatId = "") {
  if (store.loading) return skeletonList(5);
  if (store.error) return errorState(store.error, `chat:${chatId}`);
  const messages = store.messages;
  if (!messages.length && !store.pending) {
    return emptyState({
      iconName: "chat",
      title: "还没有聊过",
      hint: "发第一句吧，她会回你。",
    });
  }
  let html = "";
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const at = toMs(message.at);
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const gapPrev = prev ? at - toMs(prev.at) : Number.POSITIVE_INFINITY;
    const samePrev = Boolean(prev) && prev.side === message.side && gapPrev <= 5 * 60 * 1000;
    const sameNext = Boolean(next) && next.side === message.side && toMs(next.at) - at <= 5 * 60 * 1000;
    if (!prev || gapPrev > 5 * 60 * 1000) html += `<div class="chat-time">${escapeHtml(fmtChatTime(message.at))}</div>`;
    if (message.side === "sys") {
      html += `<div class="msg sys"><div class="bubble">${escapeHtml(message.text)}</div></div>`;
      continue;
    }
    const name = store?.meta?.name ?? "好友";
    const selfName = store?.meta?.selfName ?? "我";
    const shownName = message.side === "in" ? name : selfName;
    const avatar = message.side === "in"
      ? avatarHtml(name, { text: store?.meta?.avatarText ?? "", data: store?.meta?.avatarData ?? "" })
      : avatarHtml(selfName, { text: store?.meta?.selfAvatarText ?? "", data: store?.meta?.selfAvatarData ?? "" });
    // 每组消息的第一条前面写清楚"这是谁"（对方名字 / 我的名字）
    html += `<div class="msg ${message.side}${sameNext ? "" : " tail"}">
      ${samePrev ? '<span class="avatar-spacer"></span>' : avatar}
      <div class="msg-col">
        ${samePrev ? "" : `<div class="msg-name">${escapeHtml(shownName)}</div>`}
        <div class="bubble">${escapeHtml(message.text)}</div>
      </div>
    </div>`;
  }
  if (store.pending) {
    html += `<div class="msg in tail">${avatarHtml(store?.meta?.name ?? "她")}
      <div class="typing"><span>正在回复…</span><span class="dots"><i></i><i></i><i></i></span></div>
    </div>`;
  }
  return html;
}

function paintChat(bodyEl, store, { scroll = false, chatId = "" } = {}) {
  bodyEl.innerHTML = renderChatMessages(store, chatId);
  if (scroll) bodyEl.scrollTop = bodyEl.scrollHeight;
}

async function chatBody(route, bodyEl, ctx) {
  const id = route.id;
  const store = getChat(id);
  const cached = (cache.conversations ?? []).find((item) => item.characterId === id);
  ctx.setTitle(store.meta?.name ?? cached?.name ?? "聊天");
  if (store.loaded) {
    bodyEl.innerHTML = renderChatMessages(store, id);
    ctx.scrollToBottom();
  } else {
    paintChat(bodyEl, store, { chatId: id });
  }
  await loadChat(id);
  if (!ctx.alive()) return;
  const title = store.meta?.name ?? cached?.name ?? "聊天";
  ctx.setTitle(title, store.meta?.persona?.identity ?? "");
  bodyEl.innerHTML = renderChatMessages(store, id);
  ctx.scrollToBottom();
  const screen = ctx.screenEl;
  const form = $(".composer", screen);
  if (form) {
    const area = $("textarea", form);
    autoGrow(area);
    updateSendButton(form);
  }
}

async function sendChat(form) {
  const id = form.dataset.id;
  const area = $("textarea", form);
  const text = String(area?.value ?? "").trim();
  if (!text) return;
  const store = getChat(id);
  if (store.sending) return;
  const bodyEl = $("[data-body]", form.closest(".screen"));
  const key = id;
  ui.drafts[key] = "";
  area.value = "";
  autoGrow(area);
  updateSendButton(form);

  store.messages.push({ side: "out", text, at: Date.now() });
  void sfx.play("ui_msg_out");
  store.sending = true;
  store.pending = true;
  paintChat(bodyEl, store, { scroll: true, chatId: id });
  markRead(id, Date.now());
  cache.conversations = null;

  try {
    const data = await api(`/api/characters/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    store.pending = false;
    store.sending = false;
    const reply = String(data?.reply ?? "").trim();
    if (reply) {
      store.messages.push({ side: "in", text: reply, at: Date.now() });
      playMsgIn();
    } else {
      store.messages.push({ side: "sys", text: "（她这次没有回复）" });
    }
    paintChat(bodyEl, store, { scroll: true, chatId: id });
    markRead(id, Date.now());
    cache.conversations = null;
  } catch (error) {
    store.pending = false;
    store.sending = false;
    store.messages.push({ side: "sys", text: `发送失败：${errorText(error)}` });
    paintChat(bodyEl, store, { scroll: true, chatId: id });
    toast(errorText(error), "error");
  }
  const activeArea = $("textarea", form);
  // 手机上也要把焦点还回去：键盘保持打开（以前只在桌面重新聚焦，手机发完就收起）
  if (activeArea) activeArea.focus({ preventScroll: true });
}

/* ======================================================================
 * 8. 消息 tab / 聊天页
 * ==================================================================== */

function buildMessageEntries({ conversations = [], groups = [], status = {}, threads = [] } = {}) {
  const online = new Set((status?.federation?.sessions ?? []).map((session) => session.nodeId));
  const entries = [];
  for (const item of conversations ?? []) {
    entries.push({
      kind: "chat",
      id: item.characterId,
      name: item.name ?? item.characterId,
      preview: item.last?.text ?? "还没有消息",
      at: item.last?.at ?? 0,
      unread: unreadOf(item),
      href: `#/chat/${encodeURIComponent(item.characterId)}`,
    });
  }
  for (const group of groups ?? []) {
    const last = (group.messages ?? [])[group.messages.length - 1];
    entries.push({
      kind: "group",
      id: group.id,
      name: group.name ?? "群聊",
      preview: last?.text ?? "还没有消息",
      at: last?.at ?? group.updatedAt ?? 0,
      unread: 0,
      href: `#/group/${encodeURIComponent(group.id)}`,
    });
  }
  // 好友会话 = 人-人线程（不是对方的 Agent）。没有消息的好友也列出来，点进去可以直接聊人。
  for (const thread of threads ?? []) {
    if (!thread?.nodeId) continue;
    const isOnline = online.has(thread.nodeId);
    const hasHuman = Number(thread.count ?? 0) > 0;
    const peerRecord = (status?.peers ?? []).find((item) => item.nodeId === thread.nodeId);
    entries.push({
      kind: "peer",
      id: thread.nodeId,
      name: peerDisplayName(thread.name || peerRecord?.human?.name, thread.nodeId),
      avatarText: thread.avatarText ?? peerRecord?.human?.avatarText ?? "",
      avatarData: thread.avatarData ?? peerRecord?.human?.avatarData ?? "",
      preview: hasHuman
        ? `${thread.lastFromSelf ? "我：" : ""}${thread.lastText}`
        : isOnline ? "好友 · 在线" : "好友 · 离线",
      at: thread.lastAt || peerRecord?.lastSeenAt || peerRecord?.pairedAt || 0,
      unread: Number(thread.unread ?? 0) || 0,
      href: `#/remote/${encodeURIComponent(thread.nodeId)}/human`,
      online: isOnline,
    });
  }
  entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return entries;
}

function messageEntriesSignature(entries) {
  return (entries ?? [])
    .map((item) => `${item.kind}:${item.id}:${item.at}:${item.unread ?? 0}:${item.online ? 1 : 0}:${item.preview ?? ""}`)
    .join("|");
}

function paintMessageEntries(bodyEl, entries) {
  const query = ui.searchQuery.trim().toLowerCase();
  const filtered = query
    ? entries.filter((item) => `${item.name} ${item.preview}`.toLowerCase().includes(query))
    : entries;
  const searchBar = ui.searchOpen
    ? `<div class="inline-form"><input type="search" data-filter="messages" placeholder="搜索名字或消息" value="${escapeHtml(ui.searchQuery)}" aria-label="搜索对话" /><button class="btn ghost sm" type="button" data-act="toggle-search">取消</button></div>`
    : "";
  if (!entries.length) {
    bodyEl.innerHTML = `${searchBar}${emptyState({
      iconName: "chat",
      title: "还没有对话",
      hint: "新建一个 Agent，从第一句话开始；加了好友或建了群也会出现在这里。",
      action: '<button class="btn primary" type="button" data-go="#/new">新建 Agent</button>',
    })}`;
    return;
  }
  const rows = filtered.map((item) => {
    const avatar = item.kind === "group"
      ? `<span class="avatar">${icon("group")}</span>`
      : avatarHtml(item.name || "?", { online: item.kind === "peer" && item.online, text: item.avatarText, data: item.avatarData });
    const time = item.at ? escapeHtml(fmtListTime(item.at)) : "";
    const unread = item.unread ? `<span class="badge">${item.unread > 99 ? "99+" : item.unread}</span>` : "";
    return `<button class="row${ui.route?.kind === "chat" && ui.route.id === item.id ? " active" : ""}" type="button" data-go="${item.href}"${item.kind === "peer" ? ` data-peer="${escapeHtml(item.id)}"` : ""}>
      <span class="avatar-wrap">${avatar}${unread}</span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">${escapeHtml(item.name ?? item.id)}</span>
          <span class="row-time">${time}</span>
        </span>
        <span class="row-line"${item.kind === "peer" ? ` data-peer-preview="${escapeHtml(item.id)}"` : ""}>${escapeHtml(shortText(item.preview, 40))}</span>
      </span>
    </button>`;
  }).join("");
  bodyEl.innerHTML = `${searchBar}${filtered.length
    ? `<div class="list">${rows}</div>`
    : emptyState({ iconName: "search", title: "没有匹配的对话", hint: `没有找到“${ui.searchQuery}”。` })}`;
}

let listPollTimer = null;

function stopListPoll() {
  if (listPollTimer) {
    clearInterval(listPollTimer);
    listPollTimer = null;
  }
  ui.listRefresh = null;
}

async function loadMessageData() {
  const [conversations, groups, status, threads] = await Promise.all([
    loaders.conversations(true),
    loaders.groups(true).catch(() => []),
    loaders.status(true).catch(() => ({ peers: [], federation: {} })),
    loaders.humanThreads(true).catch(() => []),
  ]);
  return { conversations, groups, status, threads };
}

async function messagesBody(route, bodyEl, ctx) {
  stopListPoll();
  stopThreadPoll();
  bodyEl.innerHTML = skeletonList(5);
  let data;
  try {
    data = await loadMessageData();
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "conversations");
    return;
  }
  if (!ctx.alive()) return;
  let entries = buildMessageEntries(data);
  let signature = messageEntriesSignature(entries);
  paintMessageEntries(bodyEl, entries);
  ctx.restoreScroll();
  // 启动后台重连要几秒：只做"原地更新在线点/文案"，绝不整页重渲染（整页重渲染会闪屏）
  if (entries.some((item) => item.kind === "peer" && !item.online)) {
    setTimeout(async () => {
      try {
        const fresh = await loaders.status(true);
        const onlineNow = new Set((fresh.federation?.sessions ?? []).map((session) => session.nodeId));
        for (const nodeId of onlineNow) {
          const row = document.querySelector(`[data-peer="${CSS.escape(nodeId)}"]`);
          if (!row) continue;
          const avatar = row.querySelector(".avatar");
          if (avatar && !avatar.querySelector(".online-dot")) {
            const dot = document.createElement("i");
            dot.className = "online-dot";
            avatar.append(dot);
          }
          const preview = row.querySelector(`[data-peer-preview="${CSS.escape(nodeId)}"]`);
          // 只改"好友 · 在线/离线"这种占位文案；已经聊过人的行保留最后一句
          if (preview && String(preview.textContent ?? "").startsWith("好友 ·")) preview.textContent = "好友 · 在线";
        }
      } catch {
        /* 下次进页面再说 */
      }
    }, 4000);
  }
  // 新消息进来时列表也要跟着动：桌面浏览器页面常驻可见，不会触发 visibilitychange
  let listLastAt = 0;
  const listRefreshNow = async () => {
    if (!ctx.alive()) {
      stopListPoll();
      return;
    }
    // 手机端聊天页里列表是隐藏的：别让它在后台每 3 秒打 4 个接口（之前把限流打满的元凶之一）
    if (!isDesktop() && ui.route?.kind !== "messages") return;
    if ($("#layers")?.children?.length) return; // 有弹层时别抢
    try {
      const fresh = await loadMessageData();
      const next = buildMessageEntries(fresh);
      const nextSignature = messageEntriesSignature(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      // 不在那个聊天页时，也要有"新消息"提示音（像其他聊天软件）；聊天页里由落地音负责
      const newest = next[0];
      const isIncomingPeer = newest
        && newest.kind === "peer"
        && Number(newest.unread ?? 0) > 0
        && !String(newest.preview ?? "").startsWith("我：");
      const inThatChat = ui.route?.kind === "remote" && ui.route?.nodeId === newest?.id;
      if (isIncomingPeer && !document.hidden && Number(newest.at ?? 0) > listLastAt && !inThatChat && performance.now() - lastMsgSoundAt > 1200) {
        void sfx.play("ui_confirm", { minGap: 1.5, volume: 0.7 });
      }
      if (newest) listLastAt = Math.max(listLastAt, Number(newest.at ?? 0));
      const savedTop = bodyEl.scrollTop;
      paintMessageEntries(bodyEl, next);
      bodyEl.scrollTop = savedTop;
    } catch {
      /* 下一轮再试 */
    }
  };
  ui.listRefresh = listRefreshNow;
  listPollTimer = setInterval(listRefreshNow, 8000);
}

function renderChatScreen(route, bodyEl, ctx) {
  return chatBody(route, bodyEl, ctx);
}


function humanMessagesOf(messages, selfNodeId) {
  return (messages ?? [])
    .map((message) => ({
      side: message.from === selfNodeId ? "out" : "in",
      text: message.text ?? "",
      at: message.at,
    }))
    .sort((a, b) => a.at - b.at);
}

async function remoteChatBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(5);
  const nodeId = route.nodeId;
  let status = { federation: { sessions: [] }, peers: [] };
  let identity = null;
  let selfCard = null;
  let human = { messages: [], peer: {} };
  let peer = null;
  try {
    [status, identity, selfCard] = await Promise.all([
      loaders.status(true).catch(() => status),
      loaders.identity().catch(() => null),
      loaders.humanSelf(true).catch(() => null),
    ]);
    peer = (status.peers ?? []).find((item) => item.nodeId === nodeId) ?? null;
    if (!peer) {
      if (!ctx.alive()) return;
      bodyEl.innerHTML = emptyState({
        iconName: "contacts",
        title: "找不到这个好友",
        hint: "对方可能已经撤销了这台机器的连接。",
        action: '<button class="btn ghost" type="button" data-go="#/contacts">返回通讯录</button>',
      });
      return;
    }
    human = await api(`/api/human/${encodeURIComponent(nodeId)}/messages?limit=200`)
      .catch(() => ({ messages: [], peer: {} }));
  } catch (error) {
    if (!ctx.alive()) return;
    bodyEl.innerHTML = errorState(errorText(error), "remote");
    return;
  }
  if (!ctx.alive()) return;
  const online = (status.federation?.sessions ?? []).some((session) => session.nodeId === nodeId);
  // 好友聊天就是"和人聊"：不再提供"对方本人 / 对方的 Agent"的切换
  const peerCard = human.peer?.human ?? peer.human ?? null;
  const peerName = peerDisplayName(peerCard?.name || human.peer?.name || peer.name, nodeId);
  const selfName = selfDisplayName(selfCard);
  const meta = {
    name: peerName,
    selfName,
    avatarText: peerCard?.avatarText ?? "",
    avatarData: peerCard?.avatarData ?? "",
    selfAvatarText: selfCard?.avatarText ?? "",
    selfAvatarData: selfCard?.avatarData ?? "",
  };
  ctx.setTitle(peerName, online ? "在线" : "离线");

  const selfNodeId = identity?.nodeId ?? "";
  const messages = humanMessagesOf(human.messages, selfNodeId);
  const banner = messages.length === 0
    ? `<div class="panel-note" style="margin:0 14px 8px">这是和 ${escapeHtml(peerName)} 本人聊天；TA 看不到你隔离间里的 Agent。</div>`
    : "";
  bodyEl.innerHTML = `${banner}${renderChatMessages({
    messages,
    loading: false,
    error: null,
    pending: false,
    meta,
  }, `human:${nodeId}`)}`;
  ctx.scrollToBottom();
  api(`/api/human/${encodeURIComponent(nodeId)}/read`, {
    method: "POST",
    body: JSON.stringify({ at: Date.now() }),
  })
    .then(() => {
      cache.humanThreads = null;
      ui.listRefresh?.(); // 已读后立刻刷左侧列表，红点即时消失
    })
    .catch(() => {
      /* 已读失败不影响阅读 */
    });

  // 对方发来的消息不会自己出现在屏幕上：每 1.5 秒拉一次，只有内容/名片变了才重绘（避免闪屏）
  startThreadPoll({ nodeId, selfNodeId, bodyEl, ctx, signature: messageSignature(human.messages), meta, onlineText: online ? "在线" : "离线" });
}

let threadPollTimer = null;

function stopThreadPoll() {
  if (threadPollTimer) {
    clearInterval(threadPollTimer);
    threadPollTimer = null;
  }
  ui.liveRefresh = null;
}

/** 用消息 id 串当"内容指纹"；没有 id 就退回时间+正文。 */
function messageSignature(messages) {
  return (messages ?? [])
    .map((message) => message?.id ?? `${message?.at ?? 0}:${message?.text ?? ""}`)
    .join("|");
}

function startThreadPoll({ nodeId, selfNodeId, bodyEl, ctx, signature, meta, onlineText = "" }) {
  stopThreadPoll();
  let lastSignature = signature;
  const tick = async () => {
    if (!ctx.alive() || ui.route?.kind !== "remote") {
      stopThreadPoll();
      return;
    }
    try {
      const data = await api(`/api/human/${encodeURIComponent(nodeId)}/messages?limit=200`);
      const list = data?.messages ?? [];
      // 对方改名/换头像后，聊天页也要跟着变（否则会一直显示旧名字）
      const peerCard = data?.peer?.human ?? null;
      const nextName = peerDisplayName(peerCard?.name || data?.peer?.name || meta.name, nodeId);
      const nextAvatar = peerCard?.avatarText ?? meta.avatarText;
      const nameChanged = nextName !== meta.name || nextAvatar !== meta.avatarText;
      if (nameChanged) {
        meta.name = nextName;
        meta.avatarText = nextAvatar;
        ctx.setTitle(nextName, onlineText);
      }
      const nextSignature = messageSignature(list);
      if (nextSignature === lastSignature && !nameChanged) return;
      const grew = list.length > lastSignature.split("|").filter(Boolean).length;
      // 收到对方的新消息才响；自己发的消息被轮询回来不响
      if (grew) {
        const lastMsg = list[list.length - 1];
        if (lastMsg && lastMsg.from !== selfNodeId) playMsgIn();
      }
      const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
      lastSignature = nextSignature;
      bodyEl.innerHTML = renderChatMessages({
        messages: humanMessagesOf(list, selfNodeId),
        loading: false,
        error: null,
        pending: false,
        meta,
      }, `human:${nodeId}`);
      if (grew || nearBottom) ctx.scrollToBottom();
      api(`/api/human/${encodeURIComponent(nodeId)}/read`, {
        method: "POST",
        body: JSON.stringify({ at: Date.now() }),
      })
        .then(() => {
          cache.humanThreads = null;
          ui.listRefresh?.();
        })
        .catch(() => {});
    } catch {
      /* 下一轮再试 */
    }
  };
  ui.liveRefresh = tick; // SSE 收到人-人消息时直接调用，不再等 1.5s
  threadPollTimer = setInterval(tick, 5000);
}

async function fishBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  try {
    const [characterData, memoryData] = await Promise.all([
      api(`/api/characters/${encodeURIComponent(route.id)}`),
      api(`/api/characters/${encodeURIComponent(route.id)}/memory?limit=50`).catch(() => ({ memory: [] })),
    ]);
    if (!ctx.alive()) return;
    const character = characterData.character ?? {};
    const state = characterData.state ?? {};
    const memory = memoryData.memory ?? [];
    ctx.setTitle(character.name ?? "资料", character.persona?.identity ?? "");
    bodyEl.innerHTML = `
      <div class="profile-card">
        ${avatarHtml(character.name ?? "?", { cls: "lg" })}
        <div class="profile-main">
          <div class="profile-name">${escapeHtml(character.name ?? route.id)}</div>
          <div class="profile-meta">${escapeHtml(character.persona?.identity ?? "没有写人设")}</div>
          <div class="profile-id">${escapeHtml(route.id)}</div>
        </div>
      </div>
      <div class="chip-row">
        <span class="chip">引擎 ${escapeHtml(character.brain?.engine ?? "mock")}</span>
        <span class="chip">模型 ${escapeHtml(character.brain?.model ?? "—")}</span>
        <span class="chip">情绪 ${escapeHtml(state.mood ?? "平静")}</span>
        <span class="chip">事件 ${Number(state.eventCount ?? 0)}</span>
      </div>
      <div class="form-actions" style="padding:0 14px 16px">
        <button class="btn primary block" type="button" data-go="#/chat/${encodeURIComponent(route.id)}">${icon("chat")} 发消息</button>
        <button class="btn ghost block" type="button" data-act="snapshot" data-id="${escapeHtml(route.id)}">拍一张状态快照</button>
      </div>
      <div class="section-title">记忆（${memory.length}）</div>
      ${memory.length
        ? `<div class="sp-list">${memory.map((item) => `<div class="sp-item"><div class="sp-text">${escapeHtml(item.text ?? item.content ?? JSON.stringify(item))}</div><div class="sp-head" style="margin-top:4px"><span>${escapeHtml(item.source ?? "记忆")}</span><span>${escapeHtml(fmtDateOnly(item.at ?? item.createdAt))}</span></div></div>`).join("")}</div>`
        : `<div class="panel-note">还没有记忆。和她多聊几句，或从 SOUL.md 导入。</div>`}
    `;
  } catch (error) {
    if (!ctx.alive()) return;
    bodyEl.innerHTML = errorState(errorText(error), "fish");
  }
}

async function newAgentBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = `
    <form class="form" data-form="new-fish" novalidate>
      <div class="field">
        <label for="fish-name">名字</label>
        <input id="fish-name" name="name" type="text" maxlength="24" placeholder="例如：小雨" autocomplete="off" required />
      </div>
      <div class="field">
        <label for="fish-identity">一句话人设</label>
        <textarea id="fish-identity" name="identity" maxlength="200" placeholder="例如：夜班护士，话少，喜欢在窗边看雨。"></textarea>
        <div class="hint">人设越具体，她说话越像那个人。</div>
      </div>
      <div class="field">
        <label for="fish-engine">大脑引擎</label>
        <select id="fish-engine" name="engine">
          <option value="mock">mock · 本地占位（最快，适合试玩）</option>
          <option value="local">local · 本机模型</option>
          <option value="api">api · 云端 API（需要授权，dev 版默认关闭）</option>
        </select>
      </div>
      <div class="field">
        <label for="fish-model">模型名（可选）</label>
        <input id="fish-model" name="model" type="text" placeholder="例如：deepseek-flash" autocomplete="off" />
        <div class="hint">留空则用该引擎的默认模型。</div>
      </div>
      <div class="field err hidden" data-role="form-error"></div>
      <div class="form-actions">
        <button class="btn primary block" type="submit">创建这个 Agent</button>
        <button class="btn ghost block" type="button" data-back>取消</button>
      </div>
    </form>`;
}

/* ======================================================================
 * 9. 通讯录
 * ==================================================================== */

async function contactsBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(6);
  let status;
  let pending;
  let groups;
  try {
    [status, pending, groups] = await Promise.all([loaders.status(true), loaders.pending(true), loaders.groups(true)]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "contacts");
    return;
  }
  if (!ctx.alive()) return;
  const peers = status.peers ?? [];
  const online = new Set((status.federation?.sessions ?? []).map((session) => session.nodeId));
  const pendingRow = `<button class="row" type="button" data-go="#/contacts/pending">
    <span class="avatar">${icon("contacts")}</span>
    <span class="row-main"><span class="row-top"><span class="row-name">新的朋友</span>
      <span class="row-time">${pending.length ? badgeHtml(pending.length) : ""}</span></span>
      <span class="row-line">${pending.length ? `${pending.length} 个待确认的配对请求` : "没有新的配对请求"}</span></span>
    ${icon("chevron", "chevron")}
  </button>`;
  const peerRows = peers.length
    ? peers.map((peer) => {
        const displayName = peerDisplayName(peer.human?.name || peer.name, peer.nodeId);
        const avatarText = peer.human?.avatarText ?? "";
        return `<button class="row${ui.route?.kind === "peer" && ui.route.nodeId === peer.nodeId ? " active" : ""}" type="button" data-go="#/contacts/peer/${encodeURIComponent(peer.nodeId)}">
        ${avatarHtml(displayName, { online: online.has(peer.nodeId), text: avatarText, data: peer.human?.avatarData ?? "" })}
        <span class="row-main">
          <span class="row-top"><span class="row-name">${escapeHtml(displayName)}</span></span>
          <span class="row-line">${escapeHtml(briefId(peer.nodeId))}<span class="muted">·</span>${online.has(peer.nodeId) ? "在线" : "离线"}</span>
        </span>
        ${icon("chevron", "chevron")}
      </button>`;
      }).join("")
    : `<div class="panel-note">还没有好友。用「邀请朋友」把另一台机器加进来，配对后出现在这里。</div>`;
  const groupRows = groups.length
    ? groups.map((group) => {
        const last = (group.messages ?? [])[group.messages.length - 1];
        return `<button class="row" type="button" data-go="#/group/${encodeURIComponent(group.id)}">
          <span class="avatar">${icon("group")}</span>
          <span class="row-main"><span class="row-name">${escapeHtml(group.name ?? "群聊")}</span>
          <span class="row-line">${escapeHtml(last?.text ?? "还没有消息")}</span></span>
          ${icon("chevron", "chevron")}
        </button>`;
      }).join("")
    : `<div class="panel-note">还没有群聊。在消息页右上角「＋」或好友页新建群。</div>`;
  bodyEl.innerHTML = `
    <div class="list">
      ${pendingRow}
      <button class="row" type="button" data-go="#/contacts/invite">
        <span class="avatar">${icon("qr")}</span>
        <span class="row-main"><span class="row-name">邀请朋友</span><span class="row-line">二维码 / 链接，配对另一台机器</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-go="#/contacts/guest">
        <span class="avatar">${icon("eye")}</span>
        <span class="row-main"><span class="row-name">只读访客</span><span class="row-line">分享一个 Agent 的公开动态，只读</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-go="#/contacts/postcards">
        <span class="avatar">${icon("postcard")}</span>
        <span class="row-main"><span class="row-name">明信片</span><span class="row-line">给好友节点寄一张签名明信片</span></span>
        ${icon("chevron", "chevron")}
      </button>
    </div>
    <div class="section-title">好友</div>
    <div class="list">${peerRows}</div>
    <div class="section-title">群聊</div>
    <div class="list">${groupRows}</div>`;
  ctx.restoreScroll();
  startContactsPoll(ctx, contactsSignature(peers));
}

let contactsPollTimer = null;

/** 好友改名/换头像后，通讯录不用手动刷新也能跟上（每 3 秒对比一次名片签名）。 */
function contactsSignature(peers) {
  return (peers ?? [])
    .map((peer) => `${peer.nodeId}:${peer.human?.name ?? ""}:${peer.human?.avatarText ?? ""}`)
    .join("|");
}

function startContactsPoll(ctx, initialSignature = "") {
  if (contactsPollTimer) {
    clearInterval(contactsPollTimer);
    contactsPollTimer = null;
  }
  let last = initialSignature;
  contactsPollTimer = setInterval(async () => {
    console.log("[contacts-poll] tick", ctx.bodyEl?.isConnected, ui.route?.kind);
    // 用 bodyEl 是否还在页面上判断"这个页面还活着"（ctx.alive() 会被一次重绘弄失效）
    if (!ctx.bodyEl?.isConnected || ui.route?.kind !== "contacts") {
      clearInterval(contactsPollTimer);
      contactsPollTimer = null;
      return;
    }
    try {
      const status = await loaders.status(true);
      const sig = (status.peers ?? [])
        .map((peer) => `${peer.nodeId}:${peer.human?.name ?? ""}:${peer.human?.avatarText ?? ""}`)
        .join("|");
      if (last && sig !== last) render();
      console.log("[contacts-poll] sig", sig, "last", last);
      last = sig;
    } catch {
      /* 下一轮再试 */
    }
  }, 3000);
}

async function pendingBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(3);
  let signature = "";
  const paint = (pending) => {
    signature = pending.map((item) => item.id).join(",");
    if (!pending.length) {
      bodyEl.innerHTML = emptyState({
        iconName: "contacts",
        title: "没有待确认的配对",
        hint: "对方发起连接后会自动出现在这里（本页每 3 秒刷新一次）。核对 SAS 数字一致再接受。",
      });
      return;
    }
    bodyEl.innerHTML = `<div class="list">${pending.map((item) => {
      const peer = item.peer ?? {};
      const name = peerDisplayName(peer.name, peer.nodeId, "新朋友");
      return `<div class="row" style="align-items:flex-start">
        ${avatarHtml(name)}
        <div class="row-main">
          <div class="row-top"><span class="row-name">${escapeHtml(name)}</span>
            <span class="row-time">${escapeHtml(fmtListTime(item.createdAt))}</span></div>
          <div class="row-line">${escapeHtml(peer.nodeId ?? "")}</div>
          <div class="row-sub">SAS ${escapeHtml(item.sas ?? "—")} · 与对方屏幕上的数字一致才接受</div>
          <div class="device-actions">
            <button class="btn primary sm" type="button" data-act="pending-confirm" data-id="${escapeHtml(item.id)}" data-accept="1">接受</button>
            <button class="btn ghost sm" type="button" data-act="pending-confirm" data-id="${escapeHtml(item.id)}" data-accept="0">拒绝</button>
          </div>
        </div>
      </div>`;
    }).join("")}</div>`;
  };
  try {
    paint(await loaders.pending(true));
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "pending");
    return;
  }
  // 扫码/发起申请后对方不用手动刷新就能看到「新的朋友」
  const timer = setInterval(async () => {
    if (!ctx.alive()) {
      clearInterval(timer);
      return;
    }
    try {
      const rows = await loaders.pending(true);
      const next = rows.map((item) => item.id).join(",");
      if (next !== signature) paint(rows);
    } catch {
      /* 下一轮再试 */
    }
  }, 3000);
  timer.unref?.();
}

async function peerBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  const nodeId = route.nodeId;
  try {
    const status = await loaders.status(true);
    const peer = (status.peers ?? []).find((item) => item.nodeId === nodeId);
    if (!peer) {
      bodyEl.innerHTML = emptyState({
        iconName: "contacts",
        title: "找不到这个好友",
        hint: "对方可能已经撤销了这台机器的连接。",
        action: '<button class="btn ghost" type="button" data-go="#/contacts">返回通讯录</button>',
      });
      return;
    }
    const online = (status.federation?.sessions ?? []).some((session) => session.nodeId === nodeId);
    const humanName = peerDisplayName(peer.human?.name || peer.name, nodeId);
    ctx.setTitle(humanName, online ? "在线" : "离线");
    let tank = null;
    let tankError = "";
    try {
      const tankData = await api(`/api/federation/tank?nodeId=${encodeURIComponent(nodeId)}`);
      tank = tankData.tank ?? null;
    } catch (error) {
      tankError = error.status === 404 ? "对方还没有把隔离间同步过来（或未授予隔离间查看权限）。" : errorText(error);
    }
    if (!ctx.alive()) return;
    const chars = tank?.chars ?? [];
    const eventsByChar = tank?.events ?? {};
    ctx.bodyEl.innerHTML = `
      <div class="profile-card">
        ${avatarHtml(humanName, { cls: "lg", online, text: peer.human?.avatarText ?? "", data: peer.human?.avatarData ?? "" })}
        <div class="profile-main">
          <div class="profile-name">${escapeHtml(humanName)}</div>
          <div class="profile-meta">${online ? "在线" : "离线"} · 配对于 ${escapeHtml(fmtDateOnly(peer.pairedAt))}</div>
          <div class="profile-id">${escapeHtml(nodeId)}</div>
        </div>
      </div>
      <div class="form-actions" style="padding:0 14px 14px">
        <button class="btn primary block" type="button" data-go="#/remote/${encodeURIComponent(nodeId)}/human">${icon("me")} 和 TA 聊天</button>
      </div>
      <div class="chip-row">
        <span class="chip">${peer.grants?.tankView ? "可看隔离间" : "不可看隔离间"}</span>
        <span class="chip">${peer.grants?.chat ? "可聊天" : "不可聊天"}</span>
        <span class="chip">人-人通道 ${peer.grants?.human === false ? "已关" : "开"}</span>
        <span class="chip">最近在线 ${escapeHtml(fmtDateOnly(peer.lastSeenAt))}</span>
      </div>
      <div class="panel">
        <div class="switch-row">
          <span class="row-main"><span class="row-name">允许对方看我的隔离间</span><span class="row-sub">查看隔离间 · 本机策略</span></span>
          <button class="switch ${peer.grants?.tankView ? "on" : ""}" type="button" role="switch" aria-checked="${peer.grants?.tankView ? "true" : "false"}" aria-label="隔离间权限" data-act="peer-grant" data-id="${escapeHtml(nodeId)}" data-grant="tankView"></button>
        </div>
        <div class="switch-row">
          <span class="row-main"><span class="row-name">允许对方和我聊天</span><span class="row-sub">聊天 · 本机策略</span></span>
          <button class="switch ${peer.grants?.chat ? "on" : ""}" type="button" role="switch" aria-checked="${peer.grants?.chat ? "true" : "false"}" aria-label="聊天权限" data-act="peer-grant" data-id="${escapeHtml(nodeId)}" data-grant="chat"></button>
        </div>
      </div>
      <div class="panel">
        <div class="switch-row">
          <span class="row-main"><span class="row-name">显示对方的 Agent</span><span class="row-sub">默认关闭；关着时只看得到 TA 本人，看不到 TA 的 Agent</span></span>
          <button class="switch ${peerAgentsVisible(nodeId) ? "on" : ""}" type="button" role="switch" aria-checked="${peerAgentsVisible(nodeId) ? "true" : "false"}" aria-label="显示对方的 Agent" data-act="peer-agents" data-id="${escapeHtml(nodeId)}"></button>
        </div>
      </div>
      <div class="section-title">TA 的隔离间</div>
      ${!peerAgentsVisible(nodeId)
        ? `<div class="panel-note">对方的 Agent 默认不可见。打开上面的「显示对方的 Agent」才看得到。</div>`
        : tankError
          ? `<div class="panel-note">${escapeHtml(tankError)}</div>`
          : chars.length
            ? `<div class="sp-list">${chars.map((char) => {
                const charId = char.char ?? char.id ?? char.localId ?? "";
                const events = (eventsByChar[charId] ?? []).slice(-3).reverse();
                return `<div class="sp-item">
                  <div class="sp-head"><span>${escapeHtml(char.name ?? charId)}</span><span>${escapeHtml(fmtListTime(events[0]?.at))}</span></div>
                  <div class="sp-text">${escapeHtml(char.persona?.identity ?? (char.localId ? `本机 ID：${char.localId}` : "远端的 Agent"))}</div>
                  ${events.length ? `<div class="sp-actions" style="flex-direction:column;align-items:flex-start;gap:4px">${events.map((event) => `<div class="row-meta">${escapeHtml(shortText(event.content?.text ?? event.type, 60))}</div>`).join("")}</div>` : ""}
                </div>`;
              }).join("")}</div>`
            : `<div class="panel-note">对方的隔离间里还没有 Agent，或还没有同步。</div>`}
      <div class="section-title">连接</div>
      <div class="panel">
        ${online ? `<button class="row" type="button" data-act="peer-disconnect" data-id="${escapeHtml(nodeId)}">
          <span class="row-main"><span class="row-name">断开当前连接</span><span class="row-line">保留好友关系，下次可重新连</span></span>
          ${icon("chevron", "chevron")}
        </button>` : `<button class="row" type="button" data-act="peer-reconnect" data-id="${escapeHtml(nodeId)}">
          <span class="row-main"><span class="row-name">重新连接</span><span class="row-line">用上次的地址再试一次（对方需在线且开放组网）</span></span>
          ${icon("chevron", "chevron")}
        </button>`}
        <button class="row" type="button" data-act="peer-revoke" data-id="${escapeHtml(nodeId)}">
          <span class="row-main"><span class="row-name" style="color:var(--danger)">撤销连接</span><span class="row-line">拉黑这个节点，撤销后不再接受它的连接</span></span>
          ${icon("chevron", "chevron")}
        </button>
        <button class="row" type="button" data-act="peer-delete" data-id="${escapeHtml(nodeId)}">
          <span class="row-main"><span class="row-name" style="color:var(--danger)">删除好友</span><span class="row-line">从通讯录移除，并删除与 TA 的聊天记录（对方还能再次加你）</span></span>
          ${icon("chevron", "chevron")}
        </button>
      </div>`;
  } catch (error) {
    if (!ctx.alive()) return;
    bodyEl.innerHTML = errorState(errorText(error), "peer");
  }
}

async function groupsBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let groups;
  try {
    groups = await loaders.groups();
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "groups");
    return;
  }
  if (!ctx.alive()) return;
  if (!groups.length) {
    bodyEl.innerHTML = emptyState({
      iconName: "group",
      title: "还没有群聊",
      hint: "建一个群，把好友节点拉进来，消息会沿着已有的 1:1 连接分发。",
      action: '<button class="btn primary" type="button" data-act="new-group">新建群聊</button>',
    });
    return;
  }
  bodyEl.innerHTML = `<div class="list">${groups.map((group) => {
    const last = (group.messages ?? []).slice(-1)[0];
    const active = ui.route?.kind === "group" && ui.route.id === group.id ? " active" : "";
    return `<button class="row${active}" type="button" data-go="#/contacts/groups/${encodeURIComponent(group.id)}">
      ${avatarHtml(group.name ?? "群")}
      <span class="row-main">
        <span class="row-top"><span class="row-name">${escapeHtml(group.name ?? "群聊")}</span><span class="row-time">${escapeHtml(fmtListTime(last?.at))}</span></span>
        <span class="row-line">${last ? `${escapeHtml(shortText(last.fromName || last.from, 10))}：${escapeHtml(shortText(last.text, 26))}` : `${(group.members ?? []).length} 个成员`}</span>
      </span>
    </button>`;
  }).join("")}</div>`;
  ctx.restoreScroll();
}
/* ======================================================================
 * 10. 群聊 / 邀请 / 访客 / 明信片
 * ==================================================================== */

let groupPollTimer = null;

function stopGroupPoll() {
  if (groupPollTimer) {
    clearInterval(groupPollTimer);
    groupPollTimer = null;
  }
  ui.groupRefresh = null;
}

function groupSignature(group) {
  return (group?.messages ?? []).map((message) => `${message?.at ?? 0}:${message?.from ?? ""}`).join("|");
}

async function groupBody(route, bodyEl, ctx) {
  stopGroupPoll();
  bodyEl.innerHTML = skeletonList(5);
  let groupId = route.id;
  let signature = "";
  let selfNodeId = "";
  // 群成员名片：群快照里只有 nodeId/节点名，头像是各端本地的 peer 名片
  let cards = new Map();
  const loadCards = async () => {
    const [peersData, selfData] = await Promise.all([
      api("/api/federation/peers").catch(() => ({ peers: [] })),
      api("/api/human/self").catch(() => ({ self: null })),
    ]);
    const next = new Map();
    for (const peer of peersData?.peers ?? []) {
      next.set(peer.nodeId, {
        name: String(peer.human?.name ?? peer.name ?? ""),
        avatarText: String(peer.human?.avatarText ?? ""),
        avatarData: String(peer.human?.avatarData ?? ""),
      });
    }
    if (selfData?.self && selfNodeId) {
      next.set(selfNodeId, {
        name: String(selfData.self.name ?? ""),
        avatarText: String(selfData.self.avatarText ?? ""),
        avatarData: String(selfData.self.avatarData ?? ""),
      });
    }
    cards = next;
    groupCards = next;
    return next;
  };
  const cardsSignature = () => [...cards.entries()]
    .map(([nodeId, card]) => `${nodeId}:${card.name}|${card.avatarText}|${card.avatarData.length}`)
    .join("~");
  let lastGroupCount = 0;
  const paint = (group) => {
    const msgs = group?.messages ?? [];
    if (lastGroupCount > 0 && msgs.length > lastGroupCount) {
      const last = msgs[msgs.length - 1];
      if (last && last.from !== selfNodeId) playMsgIn();
    }
    lastGroupCount = msgs.length;
    signature = `${groupSignature(group)}#${cardsSignature()}`;
    bodyEl.innerHTML = groupMessagesHtml(group, selfNodeId, cards);
    ctx.scrollToBottom();
  };
  try {
    const [data, identity] = await Promise.all([
      api(`/api/federation/groups/${encodeURIComponent(groupId)}`),
      loaders.identity().catch(() => null),
    ]);
    if (!ctx.alive()) return;
    const group = data.group;
    selfNodeId = identity?.nodeId ?? "";
    await loadCards();
    if (!ctx.alive()) return;
    ctx.setTitle(group.name ?? "群聊", `${(group.members ?? []).length} 人`);
    paint(group);
  } catch (error) {
    if (!ctx.alive()) return;
    if (/404|not found|群不存在|group not found/i.test(String(error?.message ?? error))) {
      // 群已被别人解散 / 自己刚退群：别停在错误页上
      stopGroupPoll();
      toast("群聊已解散");
      navigate({ kind: "groups" }, { replace: true });
      return;
    }
    bodyEl.innerHTML = errorState(errorText(error), "group");
    return;
  }
  // 群消息走 1:1 通道分发；这里每 1.5 秒拉一次，内容变了才重绘（否则对方发的群消息要等你先发才出现）
  const groupRefreshNow = async () => {
    if (!ctx.alive() || ui.route?.kind !== "group") {
      stopGroupPoll();
      return;
    }
    if ($("#layers")?.children?.length) return;
    try {
      const [fresh] = await Promise.all([
        api(`/api/federation/groups/${encodeURIComponent(groupId)}`),
        loadCards(),
      ]);
      const next = `${groupSignature(fresh.group)}#${cardsSignature()}`;
      if (next === signature) return;
      signature = next;
      paint(fresh.group);
    } catch {
      /* 下一轮再试 */
    }
  };
  ui.groupRefresh = groupRefreshNow;
  groupPollTimer = setInterval(groupRefreshNow, 5000);
}

let groupCards = new Map();

function groupMessagesHtml(group, selfNodeId, cards = groupCards) {
  const messages = group?.messages ?? [];
  if (!messages.length) {
    return emptyState({
      iconName: "group",
      title: "群里还很安静",
      hint: "发第一句，群消息会沿已连接的 1:1 通道分发。",
    });
  }
  const cardOf = (nodeId) => (nodeId ? cards.get(nodeId) ?? null : null);
  const meta = messages.map((message) => {
    const own = Boolean(message.from && message.from === selfNodeId);
    return {
      message,
      own,
      side: own ? "out" : "in",
      key: own ? "__self__" : String(message.from || message.fromName || ""),
    };
  });
  let html = "";
  for (let index = 0; index < meta.length; index += 1) {
    const current = meta[index];
    const prev = meta[index - 1];
    const next = meta[index + 1];
    const at = toMs(current.message.at);
    const gapPrev = prev ? at - toMs(prev.message.at) : Number.POSITIVE_INFINITY;
    const samePrev = Boolean(prev)
      && prev.side === current.side
      && prev.key === current.key
      && gapPrev <= 5 * 60 * 1000;
    const sameNext = Boolean(next)
      && next.side === current.side
      && next.key === current.key
      && toMs(next.message.at) - at <= 5 * 60 * 1000;
    if (!prev || gapPrev > 5 * 60 * 1000) html += `<div class="chat-time">${escapeHtml(fmtChatTime(current.message.at))}</div>`;
    // 群消息的发送者：优先用本地 peer 名片（玩家自己起的昵称 + 头像），
    // 名片没同步到才退回节点名/短码。
    const card = cardOf(current.message.from);
    const name = String(card?.name ?? "").trim() || current.message.fromName || briefId(current.message.from);
    const avatarName = current.own ? (String(card?.name ?? "").trim() || "我") : name;
    const avatar = avatarHtml(avatarName, {
      text: card?.avatarText ?? "",
      data: card?.avatarData ?? "",
    });
    const nameLine = !current.own && !samePrev ? `<div class="msg-name">${escapeHtml(name)}</div>` : "";
    html += `<div class="msg ${current.side}${sameNext ? "" : " tail"}">
      ${samePrev ? '<span class="avatar-spacer"></span>' : avatar}
      ${nameLine ? `<div class="msg-col">${nameLine}<div class="bubble">${escapeHtml(current.message.text ?? "")}</div></div>` : `<div class="bubble">${escapeHtml(current.message.text ?? "")}</div>`}
    </div>`;
  }
  return html;
}

async function sendGroupChat(form) {
  const id = form.dataset.id;
  const area = $("textarea", form);
  const text = String(area?.value ?? "").trim();
  if (!text) return;
  const bodyEl = $("[data-body]", form.closest(".screen"));
  ui.drafts[`group:${id}`] = "";
  area.value = "";
  autoGrow(area);
  updateSendButton(form);
  bodyEl.innerHTML = `${bodyEl.innerHTML}<div class="msg sys"><div class="bubble">正在发送…</div></div>`;
  bodyEl.scrollTop = bodyEl.scrollHeight;
  try {
    const data = await api(`/api/federation/groups/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    const identity = await loaders.identity().catch(() => null);
    void sfx.play("ui_msg_out");
    bodyEl.innerHTML = groupMessagesHtml(data.group, identity?.nodeId);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    const deliveries = data.deliveries ?? [];
    const failed = deliveries.filter((item) => !item.ok && !item.queued);
    const queued = deliveries.filter((item) => item.queued);
    if (failed.length) toast(`已写入本机，${failed.length} 个成员未送达`, "error");
    else if (queued.length) toast(`已发出；${queued.length} 个成员暂时离线，他们上线后会自动补发`);
    cache.groups = null;
    ui.listRefresh?.();
    area?.focus({ preventScroll: true });
  } catch (error) {
    area.value = text;
    autoGrow(area);
    updateSendButton(form);
    bodyEl.innerHTML = groupMessagesHtml({ messages: [], name: "" }, null);
    bodyEl.innerHTML = errorState(errorText(error), "group", "发送失败");
    toast(errorText(error), "error");
  }
}

async function inviteBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(3);
  let invite;
  try {
    const data = await api("/api/federation/invite");
    invite = data.invite ?? {};
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "invite");
    return;
  }
  if (!ctx.alive()) return;
  const card = invite.card ?? {};
  const link = String(invite.link ?? "");
  const net = invite.network ?? {};
  const acceptLeft = Number(invite.acceptUntil ?? 0) > Date.now()
    ? Math.max(1, Math.round((Number(invite.acceptUntil) - Date.now()) / 60000))
    : 0;
  const netLine = net.opened
    ? `已自动开放组网（${escapeHtml(net.host ?? "0.0.0.0")}:${net.port ?? "?"}）。对方扫码后会发好友申请，你需要在「新的朋友」里点接受（核对同一组数字）。`
    : net.alreadyOpen
      ? `组网已开启（${escapeHtml(String(net.host ?? ""))}:${net.port ?? "?"}），对方扫码即可连上。`
      : `组网没开成：${escapeHtml(net.error ?? net.reason ?? "未知原因")}。可以到「我 → 一键组网」手动打开。`;
  bodyEl.innerHTML = `
    <div class="panel-note" style="margin:0 14px 8px">${netLine}</div>
    <div class="card">
      ${invite.qr ? `<img class="qr" src="${invite.qr}" alt="连接邀请二维码" />` : ""}
      <p style="text-align:center">让对方用「扫一扫」扫这张码、点「发送好友申请」；你也可以把链接发过去。</p>
      <div class="link-box" style="margin-top:10px">
        <input value="${escapeHtml(link)}" readonly aria-label="邀请链接" />
        <button class="btn ghost" type="button" data-act="copy" data-text="${escapeHtml(link)}">复制</button>
      </div>
    </div>
    ${card.nodeId ? `<div class="card">
      <h3>这张名片</h3>
      <div class="mono" style="margin-bottom:4px">${escapeHtml(card.nodeId)}</div>
      <p>${escapeHtml(card.name ?? "")}${card.fingerprint ? ` · 指纹 ${escapeHtml(card.fingerprint)}` : ""}</p>
    </div>` : ""}
    <div class="section-title">连接另一台机器</div>
    <form class="form" data-form="connect">
      <div class="field">
        <label for="invite-link">对方的邀请链接</label>
        <textarea id="invite-link" name="invite" rows="3" placeholder="vrlink://invite?... 或 http://…/?invite=…" required></textarea>
        <div class="hint">对方在「通讯录 → 邀请朋友」里生成的链接。</div>
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;min-height:44px">
          <input type="checkbox" name="autoConfirm" style="width:20px;height:20px;min-height:0;flex:0 0 auto" />
          <span>自动确认（跳过 SAS 核对，只对信任的机器用）</span>
        </label>
      </div>
      <div class="field err hidden" data-role="form-error"></div>
      <div class="form-actions">
        <button class="btn primary block" type="submit">连接</button>
      </div>
    </form>
    <div class="panel-note">连接时两边会显示同一组 SAS 数字；数字一致说明没有中间人。核对后到「新的朋友」里接受。</div>`;
}

async function guestBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let tokens;
  let conversations;
  try {
    [tokens, conversations] = await Promise.all([
      loaders.guests(),
      loaders.conversations().catch(() => []),
    ]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "guests");
    return;
  }
  if (!ctx.alive()) return;
  const nameOf = (id) => conversations.find((item) => item.characterId === id)?.name ?? id;
  if (!tokens.length) {
    bodyEl.innerHTML = emptyState({
      iconName: "eye",
      title: "还没有访客链接",
      hint: "生成一个只读链接，别人只能看你选中 Agent 的公开动态，不能聊天。",
      action: '<button class="btn primary" type="button" data-act="guest-create">生成访客链接</button>',
    });
    return;
  }
  bodyEl.innerHTML = `<div class="sp-list">${tokens.map((token) => {
    const url = `${location.origin}/guest/${token.id}`;
    return `<div class="sp-item">
      <div class="sp-head"><span>${escapeHtml(token.label || nameOf(token.characterId))}</span><span>到期 ${escapeHtml(fmtStamp(token.expiresAt))}</span></div>
      <div class="mono">${escapeHtml(nameOf(token.characterId))} · ${escapeHtml(token.id)}</div>
      <div class="sp-actions">
        <button class="btn ghost sm" type="button" data-act="copy" data-text="${escapeHtml(url)}">复制链接</button>
        <button class="btn ghost sm" type="button" data-act="guest-revoke" data-id="${escapeHtml(token.id)}">撤销</button>
      </div>
    </div>`;
  }).join("")}</div>`;
}

async function postcardsBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let postcards;
  let status;
  let conversations;
  try {
    [postcards, status, conversations] = await Promise.all([
      loaders.postcards(),
      loaders.status(true).catch(() => null),
      loaders.conversations().catch(() => []),
    ]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "postcards");
    return;
  }
  if (!ctx.alive()) return;
  const peers = status?.peers ?? [];
  const peerName = (nodeId) => peers.find((item) => item.nodeId === nodeId)?.name || briefId(nodeId);
  const fishName = (id) => conversations.find((item) => item.characterId === id)?.name ?? id;
  if (!postcards.length) {
    bodyEl.innerHTML = emptyState({
      iconName: "postcard",
      title: "还没有明信片",
      hint: "给好友节点寄一张签名明信片，对方会在自己的明信片里收到。",
      action: '<button class="btn primary" type="button" data-act="postcard-create">写一张</button>',
    });
    return;
  }
  bodyEl.innerHTML = `<div class="sp-list">${postcards.map((card) => `<div class="sp-item">
    <div class="sp-head"><span>${escapeHtml(peerName(card.from))} → ${escapeHtml(peerName(card.to))}</span><span>${escapeHtml(fmtStamp(card.at))}</span></div>
    <div class="sp-text">${escapeHtml(card.text ?? "")}</div>
    <div class="row-meta" style="margin-top:6px">${escapeHtml(fishName(card.character))}</div>
  </div>`).join("")}</div>`;
}

/* ======================================================================
 * 11. 发现：设备 / 插件
 * ==================================================================== */

async function discoverBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(3);
  try {
    const [devices, plugins] = await Promise.all([
      loaders.devices().catch(() => []),
      loaders.plugins().catch(() => []),
    ]);
    if (!ctx.alive()) return;
    const enabled = plugins.filter((item) => item.enabled).length;
    const rooms = [...new Set((devices ?? []).map((item) => item.room || "其他"))];
    bodyEl.innerHTML = `
      <div class="list">
        <button class="row" type="button" data-go="#/discover/devices">
          <span class="avatar">${icon("device")}</span>
          <span class="row-main"><span class="row-top"><span class="row-name">设备</span><span class="row-time">${devices.length} 个</span></span>
          <span class="row-line">${rooms.length ? escapeHtml(rooms.join(" · ")) : "还没有设备"}</span></span>
          ${icon("chevron", "chevron")}
        </button>
        <button class="row" type="button" data-go="#/discover/plugins">
          <span class="avatar">${icon("plugin")}</span>
          <span class="row-main"><span class="row-top"><span class="row-name">插件</span><span class="row-time">${plugins.length} 个</span></span>
          <span class="row-line">${enabled ? `${enabled} 个已启用` : "全部停用（安全模式或未启用）"}</span></span>
          ${icon("chevron", "chevron")}
        </button>
      </div>
      <div class="panel-note">设备与插件都在本机运行；高风险设备动作需要你当场批准。</div>`;
    ctx.restoreScroll();
  } catch (error) {
    if (!ctx.alive()) return;
    bodyEl.innerHTML = errorState(errorText(error), "discover");
  }
}

function deviceStateText(device) {
  const state = device?.state ?? {};
  switch (device?.type) {
    case "curtain":
      return Number(state.position ?? 0) > 0 ? `开到 ${Number(state.position)}%` : "关闭";
    case "light":
      return state.on ? `开 · 亮度 ${Number(state.brightness ?? 0)}%` : "关";
    case "lock":
      return state.locked ? "已上锁" : "已开锁";
    case "thermostat":
      return `设定 ${Number(state.target ?? 0)}℃ · 当前 ${Number(state.current ?? 0)}℃`;
    default: {
      const entries = Object.entries(state);
      return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(" · ") : "—";
    }
  }
}

function riskLabel(risk) {
  return { low: "低风险", medium: "中风险", high: "高风险" }[risk] ?? risk ?? "—";
}

function pluginStatusLabel(status) {
  return {
    running: "运行中",
    stopped: "已停止",
    error: "出错",
    starting: "启动中",
    stopping: "停止中",
  }[status] ?? (status || "—");
}

function sessionRoleLabel(role) {
  return { initiator: "发起方", responder: "接受方" }[role] ?? (role || "—");
}

async function devicesBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let devices;
  let conversations;
  try {
    [devices, conversations] = await Promise.all([
      loaders.devices(),
      loaders.conversations().catch(() => []),
    ]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "devices");
    return;
  }
  if (!ctx.alive()) return;
  if (!devices.length) {
    bodyEl.innerHTML = emptyState({
      iconName: "device",
      title: "还没有设备",
      hint: "需要时接入 Home Assistant 后，设备会出现在这里；没有设备就保持空着。",
    });
    return;
  }
  if (!ui.deviceChar || !conversations.some((item) => item.characterId === ui.deviceChar)) {
    ui.deviceChar = conversations[0]?.characterId ?? "";
  }
  const picker = conversations.length
    ? `<div class="field" style="padding:12px 14px 0">
        <label for="device-char">用哪个 Agent 的身份操作</label>
        <select id="device-char" data-role="device-char">
          ${conversations.map((item) => `<option value="${escapeHtml(item.characterId)}" ${item.characterId === ui.deviceChar ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </div>`
    : `<div class="panel-note">还没有 Agent，先新建一个，设备动作需要一个角色身份。</div>`;
  const rooms = [];
  for (const device of devices) {
    const room = device.room || "其他";
    if (!rooms.includes(room)) rooms.push(room);
  }
  const cards = rooms.map((room) => {
    const items = devices.filter((device) => (device.room || "其他") === room);
    return `<div class="section-title">${escapeHtml(room)}</div>${items.map((device) => `
      <div class="device-card">
        <div class="device-head">
          <span class="device-name">${escapeHtml(device.name ?? device.id)}</span>
          <span class="tag ${device.risk ?? "low"}">${escapeHtml(riskLabel(device.risk))}</span>
        </div>
        <div class="device-state">${escapeHtml(deviceStateText(device))}</div>
        <div class="device-actions">
          ${(device.capabilities ?? []).map((cap) => {
            const param = Object.keys(cap.params ?? {})[0] ?? "";
            return `<button class="btn ghost sm" type="button" data-act="device-cmd" data-id="${escapeHtml(device.id)}" data-command="${escapeHtml(cap.name)}" data-param="${escapeHtml(param)}" data-label="${escapeHtml(cap.label ?? cap.name)}">${escapeHtml(cap.label ?? cap.name)}${cap.risk === "high" ? " ⚠" : ""}</button>`;
          }).join("")}
        </div>
      </div>`).join("")}`;
  }).join("");
  bodyEl.innerHTML = `${picker}${cards}<div class="panel-note">高风险动作会请求你在本机批准（同意窗口），安全模式下设备动作被拦截。</div>`;
}

async function pluginsBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let plugins;
  try {
    plugins = await loaders.plugins();
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "plugins");
    return;
  }
  if (!ctx.alive()) return;
  if (!plugins.length) {
    bodyEl.innerHTML = emptyState({
      iconName: "plugin",
      title: "还没有插件",
      hint: "插件放在 plugins/ 目录，重启 Hub 后出现在这里。",
    });
    return;
  }
  bodyEl.innerHTML = `<div class="list">${plugins.map((plugin) => `
    <div class="row plugin-row${ui.route?.kind === "plugin" && ui.route.id === plugin.id ? " active" : ""}">
      <button class="row-main" type="button" data-go="#/discover/plugins/${encodeURIComponent(plugin.id)}" style="text-align:left;color:inherit;background:none;min-width:0">
        <span class="row-top">
          <span class="row-name">${escapeHtml(plugin.name ?? plugin.id)}</span>
          <span class="tag ${plugin.risk ?? "low"}">${escapeHtml(riskLabel(plugin.risk))}</span>
        </span>
        <span class="row-line">${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version ?? "0.0.0")}</span>
        <span class="plugin-status ${plugin.error ? "err" : plugin.enabled ? "on" : "off"}">${plugin.error ? `出错：${escapeHtml(plugin.error)}` : plugin.enabled ? `已启用 · ${escapeHtml(pluginStatusLabel(plugin.status))}` : "已停用"}</span>
      </button>
      ${switchButton("toggle-plugin", Boolean(plugin.enabled), { id: plugin.id, label: `启用 ${plugin.name}` })}
      ${icon("chevron", "chevron")}
    </div>`).join("")}</div>
    <div class="panel-note">插件只能使用你授予的权限；安全模式会一次性停用全部插件。</div>`;
}

async function pluginBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let plugins;
  let permissions;
  try {
    [plugins, permissions] = await Promise.all([
      loaders.plugins(),
      api(`/api/plugins/${encodeURIComponent(route.id)}/permissions`),
    ]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "plugin");
    return;
  }
  if (!ctx.alive()) return;
  const plugin = plugins.find((item) => item.id === route.id);
  if (!plugin) {
    bodyEl.innerHTML = emptyState({ iconName: "plugin", title: "找不到这个插件", hint: route.id });
    return;
  }
  ctx.setTitle(plugin.name ?? route.id, `v${plugin.version ?? "0.0.0"}`);
  const manifest = permissions.manifest ?? plugin.permissions ?? [];
  const granted = new Set(permissions.granted ?? plugin.granted ?? []);
  const info = new Map((plugin.permissionInfo ?? []).map((item) => [item.permission, item.description]));
  bodyEl.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(plugin.name ?? plugin.id)}</h3>
      <p>${escapeHtml(plugin.id)} · v${escapeHtml(plugin.version ?? "0.0.0")} · ${escapeHtml(riskLabel(plugin.risk))} · ${plugin.enabled ? "已启用" : "已停用"}</p>
      ${plugin.capabilities?.length ? `<div class="chip-row" style="padding:8px 0 0">${plugin.capabilities.map((cap) => `<span class="chip">${escapeHtml(cap)}</span>`).join("")}</div>` : ""}
      ${plugin.error ? `<p style="color:var(--danger);margin-top:8px">${escapeHtml(plugin.error)}</p>` : ""}
    </div>
    <div class="panel">
      <div class="switch-row">
        <span class="row-main"><span class="row-name">启用插件</span><span class="row-sub">停用后不再接收事件</span></span>
        ${switchButton("toggle-plugin", Boolean(plugin.enabled), { id: plugin.id, label: "启用插件" })}
      </div>
    </div>
    <div class="section-title">权限</div>
    <form class="form" data-form="plugin-perms" data-id="${escapeHtml(plugin.id)}">
      ${manifest.map((permission) => `<label class="switch-row" style="border-bottom:1px solid var(--line)">
        <input type="checkbox" name="perm" value="${escapeHtml(permission)}" ${granted.has(permission) ? "checked" : ""} style="width:20px;height:20px;min-height:0;flex:0 0 auto" />
        <span class="row-main"><span class="row-name">${escapeHtml(permission)}</span><span class="row-sub">${escapeHtml(info.get(permission) ?? "")}</span></span>
      </label>`).join("") || '<div class="panel-note">这个插件没有声明权限。</div>'}
      <div class="form-actions">
        <button class="btn primary block" type="submit">保存权限</button>
      </div>
    </form>
    <div class="section-title">数据</div>
    <div class="panel">
      <button class="row" type="button" data-act="plugin-purge" data-id="${escapeHtml(plugin.id)}">
        <span class="row-main"><span class="row-name" style="color:var(--danger)">清空插件存储</span><span class="row-line">删除该插件自己保存的数据，不可恢复</span></span>
        ${icon("chevron", "chevron")}
      </button>
    </div>`;
}

/* ======================================================================
 * 12. 我：身份 / 安全模式 / 备份 / 版本 / 高级
 * ==================================================================== */

async function meBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(5);
  let identity = null;
  let safeMode = false;
  try {
    [identity, safeMode] = await Promise.all([
      loaders.identity().catch(() => null),
      loaders.safeMode().catch(() => false),
      loaders.status(true).catch(() => null),
    ]);
  } catch {
    /* profile still renders with fallback */
  }
  if (!ctx.alive()) return;
  const name = identity?.fingerprint ?? "本机节点";
  const profile = profileState();
  const selfCard = await loaders.humanSelf(true).catch(() => null);
  const displayName = selfCard?.name || profile.name || name;
  const avatarText = selfCard?.avatarText || profile.avatar || displayName;
  const lan = lanState();
  bodyEl.innerHTML = `
    <button class="profile-card" type="button" data-act="edit-profile" style="width:100%;text-align:left;color:inherit;background:none;border:0">
      ${avatarHtml(avatarText, { cls: "lg", data: selfCard?.avatarData ?? "" })}
      <span class="profile-main">
        <span class="profile-name" style="display:block">${escapeHtml(displayName)}</span>
        <span class="profile-meta" style="display:block">VRlink v2 · ${safeMode ? "安全模式" : "正常运行"}</span>
        <span class="profile-id" style="display:block">${escapeHtml(identity?.nodeId ?? "正在读取节点…")}</span>
      </span>
      ${icon("chevron", "chevron")}
    </button>
    <div class="list">
      <button class="row" type="button" data-go="#/me/identity">
        <span class="avatar">${icon("shield")}</span>
        <span class="row-main"><span class="row-name">节点身份</span><span class="row-line">nodeId / 指纹 / 公钥</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-act="notify-settings">
        <span class="avatar">${icon("info")}</span>
        <span class="row-main"><span class="row-name">通知与后台</span><span class="row-line">悬浮通知 / 后台常驻（清理后台、关窗口都不下线）</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <div class="switch-row" style="border-bottom:1px solid var(--line)">
        <span class="avatar">${icon("qr")}</span>
        <span class="row-main"><span class="row-name">扫一扫</span><span class="row-sub">用相机扫邀请二维码加好友；关掉后「＋」里不再出现</span></span>
        ${switchButton("toggle-scan", scanEnabled(), { label: "扫一扫" })}
      </div>
      <div class="switch-row" style="border-bottom:1px solid var(--line)">
        <span class="avatar">${icon("lock")}</span>
        <span class="row-main"><span class="row-name">安全模式</span><span class="row-sub">停用全部插件，拦截设备动作</span></span>
        ${switchButton("toggle-safe", Boolean(safeMode), { label: "安全模式" })}
      </div>
      <div class="switch-row" style="border-bottom:1px solid var(--line)">
        <span class="avatar">${icon("spark")}</span>
        <span class="row-main"><span class="row-name">界面音效</span><span class="row-sub">按钮、开关、收消息的提示音</span></span>
        ${switchButton("toggle-sfx", !sfx.muted, { label: "界面音效" })}
      </div>
      <button class="row" type="button" data-act="sfx-volume">
        <span class="avatar">${icon("info")}</span>
        <span class="row-main"><span class="row-name">音效音量</span><span class="row-line">${Math.round(sfx.volume * 100)}% · 点一下切换 40 / 70 / 100%</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-act="open-network">
        <span class="avatar">${icon("wifi")}</span>
        <span class="row-main"><span class="row-name">一键组网</span><span class="row-line">${lan.enabled ? `已开放组网 · ${escapeHtml(lan.host)}:${lan.port}` : "仅本机 · 开放给同一 Wi-Fi / Tailscale 的朋友"}</span></span>
        ${lan.enabled ? '<span class="online-dot plain"></span>' : ""}
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-go="#/me/backup">
        <span class="avatar">${icon("refresh")}</span>
        <span class="row-main"><span class="row-name">备份与恢复</span><span class="row-line">事件日志是唯一真相，状态可重建</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-go="#/me/version">
        <span class="avatar">${icon("info")}</span>
        <span class="row-main"><span class="row-name">版本与发行版</span><span class="row-line">发行版 / 平台 / 前端版本</span></span>
        ${icon("chevron", "chevron")}
      </button>
      <button class="row" type="button" data-go="#/me/advanced">
        <span class="avatar">${icon("spark")}</span>
        <span class="row-main"><span class="row-name">高级</span><span class="row-line">远程节点 / 旧控制台 / 帮助</span></span>
        ${icon("chevron", "chevron")}
      </button>
    </div>
    <div class="panel-note">一个意识 · 多个身体。所有数据只保存在这台机器。</div>`;
  ctx.restoreScroll();
}

async function identityBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let identity;
  try {
    identity = await loaders.identity();
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "identity");
    return;
  }
  if (!ctx.alive()) return;
  if (!identity) {
    bodyEl.innerHTML = emptyState({ iconName: "shield", title: "还没有节点身份", hint: "Hub 启动时会自动生成。" });
    return;
  }
  bodyEl.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(identity.fingerprint ?? "节点")}</h3>
      <p>创建于 ${escapeHtml(fmtStamp(identity.createdAt))}</p>
      <div class="copy-row" style="margin-top:10px">
        <span class="mono">${escapeHtml(identity.nodeId)}</span>
        ${copyButton(identity.nodeId ?? "", "复制 ID")}
      </div>
    </div>
    <div class="section-title">公钥</div>
    <div class="card">
      <div class="kv"><span class="k">签名公钥</span><span class="v"><button class="btn ghost sm" type="button" data-act="copy" data-text="${escapeHtml(identity.signPublicKey ?? "")}">复制</button></span></div>
      <div class="mono" style="margin-top:8px">${escapeHtml(identity.signPublicKey ?? "—")}</div>
      <div class="kv" style="margin-top:12px"><span class="k">加密公钥</span><span class="v"><button class="btn ghost sm" type="button" data-act="copy" data-text="${escapeHtml(identity.encPublicKey ?? "")}">复制</button></span></div>
      <div class="mono" style="margin-top:8px">${escapeHtml(identity.encPublicKey ?? "—")}</div>
    </div>
    <div class="panel-note">nodeId 由公钥推导，不可伪造；好友配对时核对 SAS 数字即可防中间人。</div>`;
}

async function safeBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(2);
  let safeMode;
  let plugins;
  try {
    [safeMode, plugins] = await Promise.all([loaders.safeMode(), loaders.plugins().catch(() => [])]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "safeMode");
    return;
  }
  if (!ctx.alive()) return;
  const enabled = plugins.filter((item) => item.enabled).length;
  bodyEl.innerHTML = `
    <div class="panel">
      <div class="switch-row">
        <span class="avatar">${icon("lock")}</span>
        <span class="row-main"><span class="row-name">安全模式</span><span class="row-sub">${safeMode ? "已开启 · 插件全部停用" : "已关闭"}</span></span>
        ${switchButton("toggle-safe", Boolean(safeMode), { label: "安全模式" })}
      </div>
    </div>
    <div class="card">
      <h3>开启后会发生什么</h3>
      <p>· 所有插件立即停用，直到你手动开启。<br />· 设备动作被拦截（返回 503）。<br />· 聊天、隔离间、记忆仍然可用。</p>
    </div>
    <div class="card">
      <h3>当前插件</h3>
      <p>${plugins.length} 个插件，${enabled} 个已启用。${safeMode ? "开启安全模式时会被一次性停用。" : ""}</p>
      <div class="actions"><button class="btn ghost" type="button" data-go="#/discover/plugins">查看插件</button></div>
    </div>`;
}

async function backupBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let conversations;
  try {
    conversations = await loaders.conversations(true);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "conversations");
    return;
  }
  if (!ctx.alive()) return;
  if (!conversations.length) {
    bodyEl.innerHTML = emptyState({ iconName: "refresh", title: "没有可备份的 Agent", hint: "先新建一个 Agent。" });
    return;
  }
  bodyEl.innerHTML = `<div class="panel-note">事件日志（events）是唯一真相；状态（state）可以从事件重建。快照只是某一刻的状态备份。</div>
    <div class="list">${conversations.map((item) => `
      <div class="row" style="align-items:flex-start">
        ${avatarHtml(item.name)}
        <div class="row-main">
          <div class="row-top"><span class="row-name">${escapeHtml(item.name)}</span><span class="row-time">${Number(item.eventCount ?? 0)} 条事件</span></div>
          <div class="row-line">最近活动 ${escapeHtml(fmtListTime(item.last?.at ?? item.updatedAt))}</div>
          <div class="device-actions">
            <button class="btn ghost sm" type="button" data-act="snapshot" data-id="${escapeHtml(item.characterId)}">拍快照</button>
            <button class="btn ghost sm" type="button" data-act="snapshots" data-id="${escapeHtml(item.characterId)}" data-name="${escapeHtml(item.name)}">快照列表</button>
            <button class="btn ghost sm" type="button" data-act="recover" data-id="${escapeHtml(item.characterId)}">从事件重建</button>
          </div>
        </div>
      </div>`).join("")}</div>`;
}

async function versionBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(3);
  let health;
  let identity;
  try {
    [health, identity] = await Promise.all([loaders.health(), loaders.identity().catch(() => null)]);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "health");
    return;
  }
  if (!ctx.alive()) return;
  bodyEl.innerHTML = `
    <div class="card">
      <h3>VRlink v2</h3>
      <p>一个意识 · 多个身体</p>
    </div>
    <div class="panel" style="padding:0 14px">
      ${kv("发行版", `<span class="mono">${escapeHtml(health?.edition ?? "—")}</span>`)}
      ${kv("平台", `<span class="mono">${escapeHtml(health?.platform ?? "—")}</span>`)}
      ${kv("前端", `<span class="mono">ui-wx v0.1（分层式）</span>`)}
      ${kv("节点指纹", `<span class="mono">${escapeHtml(identity?.fingerprint ?? "—")}</span>`)}
      ${kv("运行时", `<span class="mono">${escapeHtml(health?.app ?? "vrlink-v2")}</span>`)}
    </div>
    <div class="panel-note">手机端与桌面端共用同一套界面；APK 需要重新打包才会带上最新前端（本版 0.5.1 的 APK 已包含当前界面）。</div>
    <div class="form-actions" style="padding:0 14px 24px">
      <a class="btn ghost block" href="/v2" style="text-decoration:none">打开旧控制台（/v2）</a>
    </div>`;
}

async function advancedBody(route, bodyEl, ctx) {
  bodyEl.innerHTML = skeletonList(4);
  let status;
  try {
    status = await loaders.status(true);
  } catch (error) {
    bodyEl.innerHTML = errorState(errorText(error), "status");
    return;
  }
  if (!ctx.alive()) return;
  const federation = status.federation ?? {};
  const sessions = federation.sessions ?? [];
  const listening = federation.listening ? `${federation.listening.host}:${federation.listening.port}` : "未监听";
  bodyEl.innerHTML = `
    <div class="section-title">远程节点</div>
    <div class="panel" style="padding:0 14px">
      ${kv("监听地址", `<span class="mono">${escapeHtml(listening)}</span>`)}
      ${kv("节点名", `<span class="mono">${escapeHtml(federation.name ?? "—")}</span>`)}
      ${kv("在线会话", `<span class="mono">${sessions.length} 个</span>`)}
      ${kv("中继服务", `<span class="mono">${federation.courier ? "已启用" : "未启用"}</span>`)}
    </div>
    ${sessions.length ? `<div class="chip-row">${sessions.map((session) => `<span class="chip">${escapeHtml(session.name || briefId(session.nodeId))} · ${escapeHtml(sessionRoleLabel(session.role))}</span>`).join("")}</div>` : `<div class="panel-note">当前没有已连接的节点。去「通讯录 → 邀请朋友」连接另一台机器。</div>`}
    <div class="section-title">工具</div>
    <div class="list">
      <a class="row" href="/v2" style="text-decoration:none;color:inherit">
        <span class="avatar">${icon("plugin")}</span>
        <span class="row-main"><span class="row-name">旧控制台</span><span class="row-line">/v2 · 全量调试界面</span></span>
        ${icon("chevron", "chevron")}
      </a>
      <button class="row" type="button" data-act="open-help">
        <span class="avatar">${icon("info")}</span>
        <span class="row-main"><span class="row-name">帮助</span><span class="row-line">路由、快捷键、常见问题</span></span>
        ${icon("chevron", "chevron")}
      </button>
    </div>
    <div class="panel-note">这一屏只做只读诊断；改配置请编辑 data/ 下的文件或旧控制台。</div>`;
}

/* ======================================================================
 * 13. 表单动作
 * ==================================================================== */

function formError(form, message) {
  const box = $('[data-role="form-error"]', form);
  if (!box) {
    toast(message, "error");
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearFormError(form) {
  const box = $('[data-role="form-error"]', form);
  if (box) {
    box.textContent = "";
    box.classList.add("hidden");
  }
}

async function submitProfile(form) {
  const name = String(form.name?.value ?? "").trim();
  const avatar = String(form.avatar?.value ?? "").trim();
  const avatarData = String(form.avatarData?.value ?? "").trim();
  setProfile({ name, avatar });
  // 同时写进节点的人-人名片，在线好友会自动收到（0.3.0 名片同步）
  try {
    const data = await api("/api/human/self", {
      method: "PATCH",
      body: JSON.stringify({ name, avatarText: avatar, avatarData }),
    });
    cache.humanSelf = data.self ?? null;
    cache.humanThreads = null;
    cache.status = null;
    toast("资料已保存，已同步给在线好友");
  } catch (error) {
    toast(`资料已存本机，但没同步出去：${errorText(error)}`, "error");
  }
  closeLayers();
  render();
}

/** 把用户选的图片压成 128×128 JPEG data URI（约 5–10KB），太大没法随名片同步。 */
async function compressAvatarImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("这张图片打不开"));
    img.src = dataUrl;
  });
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(size / image.width, size / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function submitNewFish(form) {
  clearFormError(form);
  const name = String(form.name?.value ?? "").trim();
  const identity = String(form.identity?.value ?? "").trim();
  const engine = String(form.engine?.value ?? "mock");
  const model = String(form.model?.value ?? "").trim();
  if (!name) {
    formError(form, "名字不能为空。");
    form.name?.focus();
    return;
  }
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    const payload = {
      name,
      persona: { identity: identity || "还没有写人设", baseline: "手动创建" },
      brain: { engine, ...(model ? { model } : {}) },
    };
    const data = await api("/api/characters", { method: "POST", body: JSON.stringify(payload) });
    cache.conversations = null;
    chats.delete(data.character?.id ?? "");
    toast(`已创建：${data.character?.name ?? name}`);
    navigate({ kind: "chat", id: data.character?.id ?? "" }, { replace: true });
  } catch (error) {
    formError(form, errorText(error));
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitConnect(form) {
  clearFormError(form);
  const invite = String(form.invite?.value ?? "").trim();
  const autoConfirm = Boolean(form.autoConfirm?.checked);
  if (!invite) {
    formError(form, "请粘贴对方的邀请链接。");
    return;
  }
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    const data = await api("/api/federation/connect", {
      method: "POST",
      body: JSON.stringify({ invite, autoConfirm }),
    });
    cache.status = null;
    cache.pending = null;
    const peer = data.peer ?? {};
    ui.connectResult = peer;
    openSheet({
      title: "已发起连接",
      body: `<div class="card" style="margin:8px 0">
        <h3>${escapeHtml(peer.name ?? "对方节点")}</h3>
        <p class="mono">${escapeHtml(peer.nodeId ?? "")}</p>
        <p style="margin-top:8px">SAS <b>${escapeHtml(peer.sas ?? "—")}</b></p>
        <p>核对对方屏幕上的数字一致，再确认配对。${autoConfirm ? "（你勾了自动确认）" : ""}</p>
        <div class="actions"><button class="btn primary" type="button" data-go="#/contacts/peer/${encodeURIComponent(peer.nodeId ?? "")}">查看好友</button></div>
      </div>`,
    });
    render();
  } catch (error) {
    formError(form, errorText(error));
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitGuest(form) {
  clearFormError(form);
  const characterId = String(form.characterId?.value ?? "");
  if (!characterId) {
    formError(form, "先选一个 Agent。");
    return;
  }
  const label = String(form.label?.value ?? "").trim();
  const ttlHours = Number(form.ttlHours?.value ?? 24);
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    const data = await api("/api/guest-tokens", {
      method: "POST",
      body: JSON.stringify({ characterId, label, ttlHours }),
    });
    cache.guests = null;
    const url = data.url ?? `${location.origin}/guest/${data.token}`;
    const guestAgentName = (cache.conversations ?? []).find((item) => item.characterId === characterId)?.name ?? "这个 Agent";
    openSheet({
      title: "访客链接已生成",
      body: `<div class="card" style="margin:8px 0">
        <p>对方只能看到「${escapeHtml(guestAgentName)}」的公开动态，不能聊天。</p>
        <div class="link-box" style="margin-top:10px">
          <input value="${escapeHtml(url)}" readonly aria-label="访客链接" />
          <button class="btn ghost" type="button" data-act="copy" data-text="${escapeHtml(url)}">复制</button>
        </div>
        <p style="margin-top:8px">到期：${escapeHtml(fmtStamp(data.expiresAt))}</p>
      </div>`,
    });
    render();
  } catch (error) {
    formError(form, errorText(error));
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitPostcard(form) {
  clearFormError(form);
  const nodeId = String(form.nodeId?.value ?? "");
  const character = String(form.character?.value ?? "");
  const text = String(form.text?.value ?? "").trim();
  if (!nodeId || !character || !text) {
    formError(form, "收件人、Agent 和正文都要填。");
    return;
  }
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    await api("/api/federation/postcards", {
      method: "POST",
      body: JSON.stringify({ nodeId, character, text }),
    });
    cache.postcards = null;
    toast("明信片已寄出");
    closeLayers();
    render();
  } catch (error) {
    formError(form, errorText(error));
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitNewGroup(form) {
  clearFormError(form);
  const name = String(form.name?.value ?? "").trim();
  const members = $$('input[name="peer"]:checked', form).map((input) => ({ nodeId: input.value }));
  if (!name) {
    formError(form, "群名不能为空。");
    return;
  }
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    const data = await api("/api/federation/groups", {
      method: "POST",
      body: JSON.stringify({ name, members }),
    });
    cache.groups = null;
    toast("群聊已创建");
    closeLayers();
    navigate({ kind: "group", id: data.group?.id ?? "" });
  } catch (error) {
    formError(form, errorText(error));
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitPluginPerms(form) {
  const id = form.dataset.id;
  const permissions = $$('input[name="perm"]:checked', form).map((input) => input.value);
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    await api(`/api/plugins/${encodeURIComponent(id)}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    });
    cache.plugins = null;
    toast("权限已保存");
    render();
  } catch (error) {
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * 人-人消息：直接落本机的人-人线程，再尝试投递。
 * 投递失败（对方离线/版本太旧）不算发送失败——消息已经存在本机，等重连后可再发。
 */
async function submitHumanChat(form) {
  const nodeId = form.dataset.node;
  const area = $("textarea", form);
  const text = String(area?.value ?? "").trim();
  if (!nodeId || !text) return;
  const button = $('button[type="submit"]', form);
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/human/${encodeURIComponent(nodeId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (area) area.value = "";
    updateSendButton(form);
    cache.humanThreads = null;
    void sfx.play("ui_msg_out");
    const delivery = data?.delivery ?? {};
    if (delivery.queued) {
      toast("对方暂时离线：消息先存在本机，TA 上线后会自动补发", "");
    } else if (delivery.ok === false) {
      const reason = delivery.code === "PEER_NO_HUMAN"
        ? "对方版本太旧，还不支持人-人通道"
        : delivery.error ?? "原因未知";
      toast(`已存在本机，没送到：${reason}`, "error");
    }
    if (ui.route?.kind === "remote") render();
    ui.listRefresh?.();
  } catch (error) {
    toast(errorText(error), "error");
  } finally {
    if (button) button.disabled = false;
    // 焦点还给输入框：手机上键盘保持打开，可以接着发
    area?.focus({ preventScroll: true });
  }
}

async function submitDevice(form) {
  const { id, command, param } = form.dataset;
  const raw = String($('[name="value"]', form)?.value ?? "").trim();
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    toast("请输入数字", "error");
    return;
  }
  closeLayers();
  await runDeviceCommand(id, command, param ? { [param]: value } : {});
}

/* ======================================================================
 * 14. 动作
 * ==================================================================== */

async function runDeviceCommand(deviceId, command, args) {
  const characterId = ui.deviceChar || document.querySelector("[data-role='device-char']")?.value || "";
  if (!characterId) {
    toast("先新建一个 Agent，设备动作需要一个角色身份", "error");
    return;
  }
  try {
    await api(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: "POST",
      body: JSON.stringify({ characterId, command, args }),
    });
    cache.devices = null;
    toast("指令已执行");
    render();
  } catch (error) {
    if (error.status === 403 && error.data?.code === "CONSENT_REQUIRED") {
      toast("高风险动作需要你在本机批准（同意窗口）", "error");
      return;
    }
    if (error.status === 503) {
      toast("安全模式下设备动作被拦截", "error");
      return;
    }
    toast(errorText(error), "error");
  }
}

async function toggleSafe() {
  const next = !Boolean(cache.safeMode);
  try {
    await api(next ? "/api/safe-mode" : "/api/safe-mode/off", { method: "POST", body: JSON.stringify({}) });
    cache.safeMode = next;
    cache.plugins = null;
    toast(next ? "已开启安全模式：插件停用、设备动作被拦截" : "已关闭安全模式");
    render();
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function togglePlugin(id) {
  const plugin = (cache.plugins ?? []).find((item) => item.id === id);
  const next = !plugin?.enabled;
  try {
    const data = await api(`/api/plugins/${encodeURIComponent(id)}/${next ? "enable" : "disable"}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (data?.ok === false) {
      toast(data.error ?? "操作失败", "error");
      return;
    }
    cache.plugins = null;
    toast(next ? "插件已启用" : "插件已停用");
    render();
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function openChatMenu(id) {
  const store = getChat(id);
  const name = store.meta?.name ?? (cache.conversations ?? []).find((item) => item.characterId === id)?.name ?? "她";
  openSheet({
    title: name,
    body: `<div class="sheet-body">
      <button class="sheet-row" type="button" data-go="#/fish/${encodeURIComponent(id)}?from=chat">${icon("contacts")} 查看资料</button>
      <button class="sheet-row" type="button" data-act="reload-chat" data-id="${escapeHtml(id)}">${icon("refresh")} 重新加载聊天记录</button>
      <button class="sheet-row" type="button" data-go="#/me/backup">${icon("shield")} 备份这个 Agent</button>
    </div>
    <button class="sheet-row sheet-cancel" type="button" data-act="close-layers">取消</button>`,
  });
}

function openGroupMembersSheet(id) {
  openSheet({
    title: "群成员",
    body: `<div class="sheet-body" data-role="group-members"><div class="panel-note">正在读取…</div></div>`,
    onMount: async ({ body }) => {
      try {
        const [data, identity, peersData, selfData] = await Promise.all([
          api(`/api/federation/groups/${encodeURIComponent(id)}`),
          loaders.identity().catch(() => null),
          api("/api/federation/peers").catch(() => ({ peers: [] })),
          api("/api/human/self").catch(() => ({ self: null })),
        ]);
        const group = data.group;
        const selfNodeId = identity?.nodeId ?? "";
        const isOwner = Boolean(group?.createdBy) && group.createdBy === selfNodeId;
        const cards = new Map();
        for (const peer of peersData?.peers ?? []) {
          cards.set(peer.nodeId, {
            name: String(peer.human?.name ?? peer.name ?? ""),
            avatarText: String(peer.human?.avatarText ?? ""),
            avatarData: String(peer.human?.avatarData ?? ""),
          });
        }
        if (selfData?.self && selfNodeId) {
          cards.set(selfNodeId, {
            name: String(selfData.self.name ?? ""),
            avatarText: String(selfData.self.avatarText ?? ""),
            avatarData: String(selfData.self.avatarData ?? ""),
          });
        }
        body.innerHTML = (group.members ?? []).map((member) => {
          const card = cards.get(member.nodeId) ?? null;
          const name = String(card?.name ?? "").trim() || member.name || briefId(member.nodeId);
          const isSelf = member.nodeId === selfNodeId;
          // 踢人：只有群主能用，而且不能踢自己
          const canKick = isOwner && !isSelf;
          return `<div class="sheet-row" style="cursor:default">
            ${avatarHtml(name, { text: card?.avatarText ?? "", data: card?.avatarData ?? "" })}
            <span class="row-main"><span class="row-name">${escapeHtml(name)}${isSelf ? "（我）" : ""}</span><span class="row-sub">${escapeHtml(briefId(member.nodeId))}</span></span>
            ${canKick ? `<button class="btn ghost sm" type="button" data-act="group-kick" data-id="${escapeHtml(id)}" data-node="${escapeHtml(member.nodeId)}" data-name="${escapeHtml(name)}">移出</button>` : ""}
          </div>`;
        }).join("");
      } catch (error) {
        body.innerHTML = `<div class="panel-note">${escapeHtml(errorText(error))}</div>`;
      }
    },
  });
}

async function openGroupMenu(id) {
  const identity = await loaders.identity().catch(() => null);
  let group = null;
  try {
    const data = await api(`/api/federation/groups/${encodeURIComponent(id)}`);
    group = data.group;
  } catch {
    /* show basic menu anyway */
  }
  const isOwner = group && identity && group.createdBy === identity.nodeId;
  openSheet({
    title: group?.name ?? "群聊",
    body: `<div class="sheet-body">
      <button class="sheet-row" type="button" data-act="group-members" data-id="${escapeHtml(id)}">${icon("group")} 群成员（${(group?.members ?? []).length}）</button>
      <button class="sheet-row" type="button" data-act="reload" data-key="groups">${icon("refresh")} 刷新</button>
      ${isOwner
        ? `<button class="sheet-row danger" type="button" data-act="group-dissolve" data-id="${escapeHtml(id)}">${icon("trash")} 解散群聊</button>`
        : `<button class="sheet-row danger" type="button" data-act="group-leave" data-id="${escapeHtml(id)}">${icon("x")} 退出群聊</button>`}
    </div>
    <button class="sheet-row sheet-cancel" type="button" data-act="close-layers">取消</button>`,
  });
}

function openFishMenu(id) {
  openSheet({
    title: "这个 Agent",
    body: `<div class="sheet-body">
      <button class="sheet-row" type="button" data-go="#/chat/${encodeURIComponent(id)}">${icon("chat")} 发消息</button>
      <button class="sheet-row" type="button" data-act="snapshot" data-id="${escapeHtml(id)}">${icon("refresh")} 拍状态快照</button>
      <button class="sheet-row" type="button" data-act="copy" data-text="${escapeHtml(id)}">${icon("copy")} 复制 ID</button>
    </div>
    <button class="sheet-row sheet-cancel" type="button" data-act="close-layers">取消</button>`,
  });
}

function clearCacheForKey(key) {
  if (!key) return;
  if (key.startsWith("chat:")) {
    const store = chats.get(key.slice(5));
    if (store) {
      store.loaded = false;
      store.loading = true;
      store.error = null;
    }
    return;
  }
  if (key === "contacts") {
    cache.status = null;
    cache.pending = null;
    cache.groups = null;
    return;
  }
  if (key === "peer") {
    cache.status = null;
    return;
  }
  if (key === "advanced") {
    cache.status = null;
    return;
  }
  if (key in cache) cache[key] = null;
}

/* ======================================================================
 * 13.5 一键组网（本机开放 / 加入朋友的网络）
 * ==================================================================== */

const netUI = {
  open: false,
  tab: "own",
  loading: true,
  busy: "",
  error: "",
  lan: { enabled: false, host: "127.0.0.1", port: 5275 },
  invite: null,
  hints: [],
  join: null,
  pollTimer: 0,
  pollStartedAt: 0,
};

function freshJoinState() {
  return { status: "idle", link: "", pending: null, sas: "", peer: null, error: "", nodeId: "" };
}

function netSasText(sas) {
  const raw = String(sas ?? "").replace(/\s+/g, "");
  if (!raw) return "—";
  return raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw;
}

function inviteNodeId(link) {
  try {
    const url = new URL(String(link ?? "").trim());
    const node = url.searchParams.get("node");
    return node ? decodeURIComponent(node) : "";
  } catch {
    return "";
  }
}

function netHintsHtml(hints) {
  if (!hints?.length) return "";
  const labels = { public: "公网", tailscale: "Tailscale", lan: "局域网", loopback: "本机" };
  return `<div class="net-hints">${hints.map((hint) => {
    const type = hint.type ?? hintTypeOf(hint.host);
    return `<span class="chip">${escapeHtml(labels[type] ?? "地址")} ${escapeHtml(hint.host)}:${hint.port}</span>`;
  }).join("")}</div>`;
}

function hintTypeOf(host) {
  const value = String(host ?? "");
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") return "loopback";
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(value)) return "tailscale";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(value)) return "lan";
  return "public";
}

function netOwnHtml() {
  const lan = netUI.lan;
  const error = netUI.error ? `<div class="net-error">${escapeHtml(netUI.error)}</div>` : "";
  if (netUI.loading && !netUI.invite) return `<div class="net-msg">正在读取组网状态…</div>`;
  if (!lan.enabled) {
    return `${error}
      <p class="net-msg">把本机开放到同一 Wi-Fi / Tailscale，朋友就能用二维码或邀请链接连进来。</p>
      <p class="net-note">开启后监听地址会从 127.0.0.1 切到 0.0.0.0，已有的联邦会话会断开，对端重连即可。</p>
      <div class="net-actions">
        <button class="btn primary block" type="button" data-act="net-enable" ${netUI.busy ? "disabled" : ""}>${netUI.busy === "enable" ? "正在开放…" : "开启一键组网"}</button>
      </div>`;
  }
  const invite = netUI.invite;
  const inviteHtml = invite
    ? `${invite.qr ? `<img class="net-qr" src="${invite.qr}" alt="组网邀请二维码" />` : ""}
       <div class="link-box">
         <input value="${escapeHtml(invite.link ?? "")}" readonly aria-label="邀请链接" />
         <button class="btn ghost" type="button" data-act="copy" data-text="${escapeHtml(invite.link ?? "")}">复制</button>
       </div>
       ${netHintsHtml(netUI.hints)}
       <p class="net-note">发给同一 Wi-Fi 或 Tailscale 的朋友；首次连接核对 6 位 SAS。</p>`
    : `<p class="net-msg">正在生成邀请二维码…</p>`;
  return `${error}${inviteHtml}
    <div class="net-actions">
      <button class="btn ghost block" type="button" data-act="net-disable" ${netUI.busy ? "disabled" : ""}>${netUI.busy === "disable" ? "正在收回…" : "收回本机"}</button>
    </div>
    <p class="net-note">收回后监听地址改回 127.0.0.1，聊天、隔离间、设备都不受影响。</p>`;
}

function netJoinHtml() {
  const join = netUI.join ?? freshJoinState();
  let html = "";
  if (join.status === "connecting") html += `<p class="net-msg">正在连接对方，等对方回应…</p>`;
  if (join.status === "pending") html += `<p class="net-msg">对方已在等待确认。核对两边屏幕上的 6 位 SAS，一致就接受。</p>`;
  if (join.status === "accepting") html += `<p class="net-msg">已接受，等待对方也接受并完成握手…</p>`;
  if (join.status === "timeout") html += `<div class="net-error">${escapeHtml(join.error || "等待超时，请确认对方已开放组网并在「新的朋友」里接受。")}</div>`;
  if (join.status === "error") html += `<div class="net-error">${escapeHtml(join.error || "连接失败，请重试。")}</div>`;
  if (join.status === "rejected") html += `<div class="net-error">已拒绝这次连接。</div>`;
  if (join.pending && (join.status === "connecting" || join.status === "pending")) {
    html += `<div class="net-sas">
      <div class="net-sas-label">对方 SAS</div>
      <div class="net-sas-code">${escapeHtml(netSasText(join.sas))}</div>
    </div>
    <div class="net-actions">
      <button class="btn primary" type="button" data-act="net-accept">接受</button>
      <button class="btn ghost danger" type="button" data-act="net-reject">拒绝</button>
    </div>
    <p class="net-note">两个屏幕上的数字完全一致才接受；不确定就拒绝。</p>`;
  }
  if (join.status === "connected") {
    html += `<div class="net-sas">
      <div class="net-sas-label">已连接 · ${escapeHtml(join.peer?.name ?? "对方节点")}</div>
      <div class="net-sas-code">${escapeHtml(netSasText(join.sas))}</div>
      <div class="net-sas-label">${escapeHtml(join.peer?.nodeId ?? "")}</div>
    </div>
    <div class="net-actions"><button class="btn primary block" type="button" data-go="#/contacts">去通讯录看看</button></div>`;
  }
  if (join.status === "idle" || join.status === "error" || join.status === "rejected" || join.status === "timeout") {
    html += `<p class="net-msg">粘贴朋友发来的邀请链接（或名片 JSON）。</p>
      <textarea class="net-link" data-role="net-link" rows="3" placeholder="vrlink://connect?v=1&amp;node=… 或 {&quot;v&quot;:1,…}">${escapeHtml(join.link)}</textarea>
      <div class="net-actions">
        <button class="btn primary block" type="button" data-act="net-join">连接</button>
      </div>
      <p class="net-note">连接请求会出现在双方「通讯录 → 新的朋友」；两边 SAS 一致再接受。</p>`;
  }
  if (join.status !== "idle" && join.status !== "connected") {
    html += `<div class="net-actions"><button class="btn ghost block" type="button" data-act="net-reset">重新填写</button></div>`;
  }
  return html;
}

function networkSheetHtml() {
  const tab = netUI.tab;
  const lan = netUI.lan;
  const status = `<div class="net-status">
    <span class="net-state ${lan.enabled ? "on" : ""}"><i class="dot"></i>${lan.enabled ? "已开放组网" : "仅本机"}</span>
    <span class="net-addr">${escapeHtml(lan.host)}:${lan.port}</span>
  </div>`;
  const tabs = `<div class="net-tabs">
    <button class="net-tab ${tab === "own" ? "on" : ""}" type="button" data-act="net-tab" data-tab="own">本机</button>
    <button class="net-tab ${tab === "join" ? "on" : ""}" type="button" data-act="net-tab" data-tab="join">加入朋友的网络</button>
  </div>`;
  return `${status}${tabs}<div class="net-body">${tab === "own" ? netOwnHtml() : netJoinHtml()}</div>`;
}

function renderNetworkSheet() {
  const existing = $("#layers [data-role='net-body']");
  if (existing) {
    existing.innerHTML = networkSheetHtml();
    return;
  }
  if (!netUI.open) return;
  openSheet({
    title: "一键组网",
    body: `<div data-role="net-body">${networkSheetHtml()}</div>`,
    onClose: () => {
      netUI.open = false;
      stopNetPoll();
    },
  });
  netUI.open = true;
}

async function loadNetworkInvite() {
  const data = await api("/api/federation/invite");
  netUI.invite = data.invite ?? null;
  netUI.hints = data.invite?.hints ?? [];
}

async function openNetworkSheet() {
  netUI.open = true;
  netUI.tab = "own";
  netUI.loading = true;
  netUI.busy = "";
  netUI.error = "";
  netUI.invite = null;
  netUI.hints = [];
  netUI.join = freshJoinState();
  netUI.lan = lanState();
  renderNetworkSheet();
  try {
    await loaders.status(true);
    netUI.lan = lanState();
    if (netUI.lan.enabled) await loadNetworkInvite();
  } catch (error) {
    netUI.error = errorText(error);
  }
  netUI.loading = false;
  renderNetworkSheet();
}

async function netEnable() {
  if (netUI.busy) return;
  netUI.busy = "enable";
  netUI.error = "";
  renderNetworkSheet();
  try {
    const data = await api("/api/network/lan", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    netUI.lan = {
      enabled: true,
      host: data.federation?.host ?? "0.0.0.0",
      port: data.federation?.port ?? netUI.lan.port,
    };
    netUI.hints = data.hints ?? [];
    cache.status = null;
    await loaders.status(true).catch(() => {});
    if (lanState().host !== "0.0.0.0") {
      cache.status = {
        ...(cache.status ?? {}),
        federation: {
          ...(cache.status?.federation ?? {}),
          listening: { host: netUI.lan.host, port: netUI.lan.port },
        },
      };
    }
    netUI.lan = lanState();
    netUI.invite = null;
    await loadNetworkInvite();
    toast("已开放一键组网");
    void sfx.play("ui_ready");
  } catch (error) {
    netUI.error = errorText(error);
    toast(errorText(error), "error");
  }
  netUI.busy = "";
  renderNetworkSheet();
  loaders.status().catch(() => {});
  render();
}

async function netDisable() {
  if (netUI.busy) return;
  netUI.busy = "disable";
  netUI.error = "";
  renderNetworkSheet();
  try {
    const data = await api("/api/network/lan", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    netUI.lan = {
      enabled: false,
      host: data.federation?.host ?? "127.0.0.1",
      port: data.federation?.port ?? netUI.lan.port,
    };
    netUI.invite = null;
    netUI.hints = [];
    cache.status = null;
    await loaders.status(true).catch(() => {});
    if (lanState().host !== "127.0.0.1") {
      cache.status = {
        ...(cache.status ?? {}),
        federation: {
          ...(cache.status?.federation ?? {}),
          listening: { host: netUI.lan.host, port: netUI.lan.port },
        },
      };
    }
    netUI.lan = lanState();
    toast("已收回本机");
  } catch (error) {
    netUI.error = errorText(error);
    toast(errorText(error), "error");
  }
  netUI.busy = "";
  renderNetworkSheet();
  loaders.status().catch(() => {});
  render();
}

function stopNetPoll() {
  if (netUI.pollTimer) {
    clearInterval(netUI.pollTimer);
    netUI.pollTimer = 0;
  }
}

function startNetPoll() {
  stopNetPoll();
  netUI.pollStartedAt = Date.now();
  const tick = async () => {
    const status = netUI.join?.status;
    if (!netUI.open || !["connecting", "pending"].includes(status)) {
      stopNetPoll();
      return;
    }
    if (Date.now() - netUI.pollStartedAt > 90000 && status !== "pending") {
      netUI.join.status = "timeout";
      netUI.join.error = "等待超时：请确认对方已开放组网，并在「新的朋友」里接受。";
      stopNetPoll();
      renderNetworkSheet();
      return;
    }
    try {
      const data = await api("/api/federation/pending");
      const list = data.pending ?? [];
      if (!list.length) return;
      const expected = netUI.join.nodeId;
      const target = (expected && list.find((item) => item.peer?.nodeId === expected)) || list[0];
      const changed = !netUI.join.pending || netUI.join.pending.id !== target.id;
      netUI.join.pending = target;
      netUI.join.sas = target.sas ?? netUI.join.sas;
      if (netUI.join.status === "connecting") netUI.join.status = "pending";
      if (changed) renderNetworkSheet();
    } catch {
      /* transient errors: next tick retries */
    }
  };
  netUI.pollTimer = setInterval(tick, 1500);
  tick();
}

async function netJoin() {
  if (netUI.join?.status === "connecting" || netUI.join?.status === "pending" || netUI.join?.status === "accepting") return;
  const link = String(netUI.join?.link ?? "").trim();
  if (!link) {
    netUI.join.status = "error";
    netUI.join.error = "请先粘贴邀请链接。";
    renderNetworkSheet();
    return;
  }
  netUI.join = {
    status: "connecting",
    link,
    pending: null,
    sas: "",
    peer: null,
    error: "",
    nodeId: inviteNodeId(link),
  };
  renderNetworkSheet();
  startNetPoll();
  try {
    const data = await api("/api/federation/connect", {
      method: "POST",
      body: JSON.stringify({ invite: link, link, autoConfirm: false }),
    });
    netUI.join.status = "connected";
    netUI.join.peer = data.peer ?? null;
    netUI.join.sas = data.peer?.sas ?? netUI.join.sas;
    netUI.join.pending = null;
    netUI.join.error = "";
    cache.status = null;
    cache.pending = null;
    stopNetPoll();
    toast(`已连接：${data.peer?.name ?? "对方节点"}`);
    void sfx.play("ui_ready");
    loaders.status().catch(() => {});
  } catch (error) {
    stopNetPoll();
    if (netUI.join.status !== "rejected") {
      const code = error.data?.code ?? "";
      if (code === "BAD_INVITE") {
        netUI.join.status = "error";
        netUI.join.error = "链接格式不正确：请粘贴对方「本机 → 已开放组网」里复制的邀请链接。";
      } else if (/timed out|pairing timed out/i.test(error.message ?? "")) {
        netUI.join.status = "timeout";
        netUI.join.error = "等待对方接受超时：请确认对方已开放组网，并在「新的朋友」里接受。";
      } else if (code === "PEER_BLOCKED") {
        netUI.join.status = "error";
        netUI.join.error = "对方已撤销/拉黑了这台机器，无法连接。";
      } else {
        netUI.join.status = "error";
        netUI.join.error = `连接失败：${errorText(error)}`;
      }
    }
  }
  renderNetworkSheet();
  render();
}

async function netAccept() {
  const pending = netUI.join?.pending;
  if (!pending) return;
  netUI.join.status = "accepting";
  netUI.join.sas = netUI.join.sas || pending.sas;
  renderNetworkSheet();
  try {
    await api("/api/federation/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ id: pending.id, accept: true }),
    });
    netUI.join.pending = null;
    cache.pending = null;
    cache.status = null;
    void sfx.play("ui_ready");
    renderNetworkSheet();
  } catch (error) {
    netUI.join.status = "error";
    netUI.join.error = `接受失败：${errorText(error)}`;
    renderNetworkSheet();
  }
}

async function netReject() {
  const pending = netUI.join?.pending;
  if (!pending) return;
  netUI.join.status = "rejected";
  netUI.join.pending = null;
  netUI.join.error = "";
  renderNetworkSheet();
  try {
    await api("/api/federation/pending/confirm", {
      method: "POST",
      body: JSON.stringify({ id: pending.id, accept: false }),
    });
  } catch (error) {
    netUI.join.error = `拒绝失败：${errorText(error)}`;
  }
  cache.pending = null;
  stopNetPoll();
  renderNetworkSheet();
}

const ACTIONS = {
  retry(el) {
    clearCacheForKey(el.dataset.key);
    render();
  },
  reload(el) {
    const key = el.dataset.key;
    if (key) cache[key] = null;
    closeLayers();
    render();
    toast("已刷新");
  },
  "close-layers"() {
    closeLayers();
  },
  "open-network"() {
    openNetworkSheet();
  },
  "net-tab"(el) {
    netUI.tab = el.dataset.tab === "join" ? "join" : "own";
    renderNetworkSheet();
  },
  "net-enable"() {
    netEnable();
  },
  "net-disable"() {
    netDisable();
  },
  "net-join"() {
    netJoin();
  },
  "net-accept"() {
    netAccept();
  },
  "net-reject"() {
    netReject();
  },
  "net-reset"() {
    stopNetPoll();
    netUI.join = freshJoinState();
    renderNetworkSheet();
  },
  "open-settings"() {
    const native = window.__vrNative;
    if (native && typeof native.call === "function") {
      native
        .call("ui.settings", {}, {})
        .catch((error) => toast(`打不开设置：${errorText(error)}`, "error"));
      return;
    }
    navigate({ kind: "me" });
  },
  "toggle-search"() {
    ui.searchOpen = !ui.searchOpen;
    if (!ui.searchOpen) ui.searchQuery = "";
    render();
  },
  "contacts-add"() {
    openSheet({
      title: "添加",
      body: `<div class="sheet-body">
        ${scanEnabled() ? `<button class="sheet-row" type="button" data-act="scan-open">${icon("qr")} 扫一扫，加好友</button>` : ""}
        <button class="sheet-row" type="button" data-go="#/contacts/invite">${icon("qr")} 邀请朋友 / 连接另一台机器</button>
        <button class="sheet-row" type="button" data-act="new-group">${icon("group")} 新建群聊</button>
        <button class="sheet-row" type="button" data-go="#/contacts/pending">${icon("contacts")} 新的朋友</button>
        <button class="sheet-row" type="button" data-go="#/contacts/guest">${icon("eye")} 只读访客</button>
      </div>
      <button class="sheet-row sheet-cancel" type="button" data-act="close-layers">取消</button>`,
    });
  },
  "scan-open"() {
    openScanner();
  },
  "scan-manual-go"(el) {
    const bodyEl = el.closest(".sheet-body") ?? document;
    const value = String($('[data-role="scan-manual"]', bodyEl)?.value ?? "").trim();
    if (!value) {
      toast("先粘贴对方的邀请链接", "error");
      return;
    }
    showScannedInvite(value);
  },
  "scan-send"(el) {
    return sendFriendRequestFromScan(el);
  },
  "scan-flip"(el) {
    scanFacing = scanFacing === "environment" ? "user" : "environment";
    stopScanner();
    const bodyEl = el.closest(".sheet-body") ?? document;
    scanSay($('[data-role="scan-status"]', bodyEl), scanFacing === "environment" ? "切到后置镜头…" : "切到前置镜头…");
    startScanner(bodyEl);
  },
  async "notify-settings"() {
    const native = window.__vrNative;
    if (!native || typeof native.call !== "function") {
      toast("这个环境没有系统通知设置（浏览器版）");
      return;
    }
    try {
      const overlay = await native.call("notify.overlay", {}, {});
      const full = await native.call("notify.fullscreen", {}, {});
      if (overlay?.granted && full?.granted) {
        toast("气泡已开启。小米/红米还要加一步：设置→应用设置→VRlink→省电策略「无限制」+ 允许自启动，这样清理后台才不掉线");
        return;
      }
      if (!overlay?.granted) {
        await native.call("notify.overlay-settings", {}, {});
        toast("请允许「显示在其他应用上层」——亮屏时的悬浮气泡靠它");
        return;
      }
      await native.call("notify.fullscreen-settings", {}, {});
      toast("请允许「全屏通知」——锁屏时也能弹出气泡");
    } catch (error) {
      toast(`打不开设置：${errorText(error)}`, "error");
    }
  },
  "toggle-scan"(el) {
    const next = !scanEnabled();
    setScanEnabled(next);
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
    toast(next ? "扫一扫已打开" : "扫一扫已关掉，「＋」里不再出现");
  },
  "chat-menu"(el) {
    openChatMenu(el.dataset.id);
  },
  "group-menu"(el) {
    openGroupMenu(el.dataset.id);
  },
  "fish-menu"(el) {
    openFishMenu(el.dataset.id);
  },
  "reload-chat"(el) {
    clearLayers();
    clearCacheForKey(`chat:${el.dataset.id}`);
    render();
  },
  async "pending-confirm"(el) {
    const accept = el.dataset.accept === "1";
    try {
      await api("/api/federation/pending/confirm", {
        method: "POST",
        body: JSON.stringify({ id: el.dataset.id, accept }),
      });
      cache.pending = null;
      cache.status = null;
      toast(accept ? "已接受配对" : "已拒绝");
      render();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  "compose-menu"() {
    openSheet({
      title: "新建",
      body: `<div class="list">
        <button class="sheet-row" type="button" data-act="new-group">${icon("group")} 新建群组</button>
        <button class="sheet-row" type="button" data-go="#/new">${icon("plus")} 新建对象（创建一个自己的 Agent）</button>
        ${scanEnabled() ? `<button class="sheet-row" type="button" data-act="scan-open">${icon("qr")} 扫一扫，加好友</button>` : ""}
        <!-- @seed-strip-start -->
        <button class="sheet-row" type="button" data-act="migrate-open">${icon("backup")} 一键迁移（旧数据 / 记忆文件夹）</button>
        <!-- @seed-strip-end -->
      </div>`,
    });
  },
  // @seed-strip-start
  "migrate-open"() {
    openSheet({
      title: "一键迁移",
      body: `<div class="form">
        <div class="hint" style="margin-bottom:10px">支持两种来源：旧版 VRlink 的 data 目录；或一个装着 .md / .jsonl 的记忆文件夹。迁移后：Agent 进「消息」，记忆按来源分到每个 Agent 的资料页，事件日志进备份与恢复。</div>
        <div class="field"><label for="mg-from">旧数据目录（电脑上的绝对路径）</label><input id="mg-from" name="from" placeholder="例如 D:\\VRlink\\data" /></div>
        <div class="field"><label for="mg-data">迁移到（当前节点数据目录，留空自动）</label><input id="mg-data" name="data" placeholder="留空 = 当前 App 数据目录" /></div>
        <div class="panel-note" style="margin:8px 0">在电脑上执行（手机端暂不支持选目录）：<br /><code style="color:#4ade80">node tools/migrate-from-v1.mjs --from &lt;旧目录&gt; --data &lt;当前目录&gt;</code></div>
        <button class="btn primary block" type="button" data-act="migrate-copy">复制命令</button>
      </div>`,
    });
  },
  "migrate-copy"() {
    const from = document.querySelector("#mg-from")?.value?.trim() || "<旧目录>";
    const data = document.querySelector("#mg-data")?.value?.trim() || "<当前目录>";
    const cmd = `node tools/migrate-from-v1.mjs --from "${from}" --data "${data}"`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd).then(() => toast("命令已复制")).catch(() => toast(cmd));
    else toast(cmd);
  },
  // @seed-strip-end
  "new-group"() {
    const peers = cache.status?.peers ?? [];
    openSheet({
      title: "新建群组",
      body: `<form class="form" data-form="new-group">
        <div class="field"><label for="ng-name">群名</label><input id="ng-name" name="name" maxlength="24" placeholder="例如：周末局" /></div>
        <div class="field"><label>拉谁进群</label>
          ${peers.length
            ? peers.map((peer) => `<label class="switch-row" style="border-bottom:1px solid var(--line)"><input type="checkbox" name="peer" value="${escapeHtml(peer.nodeId)}" style="width:20px;height:20px;min-height:0;flex:0 0 auto" /><span class="row-main"><span class="row-name">${escapeHtml(peer.name || briefId(peer.nodeId))}</span></span></label>`).join("")
            : '<div class="hint">还没有好友。先去通讯录加好友，再建群。</div>'}
        </div>
        <button class="btn primary block" type="submit">建群</button>
      </form>`,
    });
  },
  "peer-agents"(el) {
    const next = !el.classList.contains("on");
    setPeerAgentsVisible(el.dataset.id, next);
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
    toast(next ? "已显示对方的 Agent" : "已隐藏对方的 Agent");
  },
  async "edit-profile"(el) {
    const profile = profileState();
    const card = await loaders.humanSelf(true).catch(() => cache.humanSelf ?? null);
    const initialName = String(card?.name ?? profile.name ?? "").trim();
    const initialAvatar = String(card?.avatarText ?? profile.avatar ?? "").trim();
    const initialData = String(card?.avatarData ?? "").trim();
    const presets = ["🐟", "🐋", "🦈", "🐡", "🦑", "🐙", "🌊", "⚡", "🌙", "🍀", "🔥", "💎"];
    const preview = initialData
      ? `<img class="avatar-img" src="${escapeHtml(initialData)}" alt="" />`
      : escapeHtml(avatarTextOf(initialName, initialAvatar));
    openSheet({
      title: "我的资料",
      body: `<form class="form" data-form="profile">
        <div class="field"><label for="pf-name">名字（好友看到的就是这个名字）</label><input id="pf-name" name="name" maxlength="20" placeholder="例如：老王" value="${escapeHtml(initialName)}" /></div>
        <div class="field">
          <label for="pf-avatar">头像（上传图片，或选表情 / 填 1–2 个字）</label>
          <div style="display:flex;gap:12px;align-items:center;padding:4px 0 10px">
            <span class="avatar lg" id="pf-avatar-preview">${preview}</span>
            <span style="display:flex;flex-wrap:wrap;gap:8px">
              <button class="btn ghost sm" type="button" data-act="pick-avatar-file">上传图片</button>
              <button class="btn ghost sm" type="button" data-act="clear-avatar-image">去掉图片</button>
            </span>
          </div>
          <input type="file" id="pf-avatar-file" accept="image/*" style="display:none" />
          <input type="hidden" id="pf-avatar-data" name="avatarData" value="${escapeHtml(initialData)}" />
          <div class="chip-row" style="padding:0 0 8px">${presets.map((preset) => `<button class="chip" type="button" data-act="pick-avatar" data-text="${escapeHtml(preset)}" style="font-size:18px">${escapeHtml(preset)}</button>`).join("")}</div>
          <input id="pf-avatar" name="avatar" maxlength="2" placeholder="表情或 1–2 个字（图片优先）" value="${escapeHtml(initialAvatar)}" />
        </div>
        <button class="btn primary block" type="submit">保存</button>
      </form>`,
    });
    const fileInput = $("#pf-avatar-file");
    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          toast("图片太大了，换一张小一点的（8MB 以内）", "error");
          return;
        }
        try {
          const data = await compressAvatarImage(file);
          const hidden = $("#pf-avatar-data");
          if (hidden) hidden.value = data;
          const preview = $("#pf-avatar-preview");
          if (preview) preview.innerHTML = `<img class="avatar-img" src="${escapeHtml(data)}" alt="" />`;
          toast("头像图片已选好，点「保存」生效");
        } catch (error) {
          toast(errorText(error), "error");
        }
      });
    }
  },
  "pick-avatar-file"() {
    $("#pf-avatar-file")?.click();
  },
  "clear-avatar-image"() {
    const hidden = $("#pf-avatar-data");
    if (hidden) hidden.value = "";
    const preview = $("#pf-avatar-preview");
    const input = $("#pf-name");
    if (preview) preview.textContent = avatarTextOf(String(input?.value ?? ""), String($("#pf-avatar")?.value ?? ""));
    toast("已去掉头像图片，记得点保存");
  },
  "pick-avatar"(el) {
    const input = $("#pf-avatar");
    if (!input) return;
    input.value = String(el.dataset.text ?? "");
    input.focus();
  },
  async "peer-grant"(el) {
    const current = el.classList.contains("on");
    try {
      await api("/api/federation/grants", {
        method: "POST",
        body: JSON.stringify({ nodeId: el.dataset.id, grant: el.dataset.grant, value: !current }),
      });
      el.classList.toggle("on", !current);
      el.setAttribute("aria-checked", String(!current));
      cache.status = null;
      toast(!current ? "已允许" : "已关闭");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "peer-reconnect"(el) {
    try {
      await api("/api/federation/reconnect", {
        method: "POST",
        body: JSON.stringify({ nodeId: el.dataset.id }),
      });
      cache.status = null;
      toast("已重新连接");
      render();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "peer-disconnect"(el) {
    try {
      await api("/api/federation/disconnect", {
        method: "POST",
        body: JSON.stringify({ nodeId: el.dataset.id }),
      });
      cache.status = null;
      toast("已断开连接");
      render();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "peer-delete"(el) {
    const nodeId = el.dataset.id;
    const ok = await confirmDialog({
      title: "删除这个好友？",
      text: "会从通讯录移除，并删除本地与 TA 的聊天记录；对方还能再次发好友申请。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/federation/peers/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
      cache.status = null;
      cache.pending = null;
      cache.threads = null;
      toast("已删除好友");
      navigate({ kind: "contacts" }, { replace: true });
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "peer-revoke"(el) {
    const ok = await confirmDialog({
      title: "撤销这个好友？",
      text: "撤销后这个节点会被拉黑，不再接受它的连接。",
      confirmLabel: "撤销",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/federation/revoke", {
        method: "POST",
        body: JSON.stringify({ nodeId: el.dataset.id }),
      });
      cache.status = null;
      cache.pending = null;
      toast("已撤销");
      navigate({ kind: "contacts" }, { replace: true });
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  "new-group"() {
    closeLayers();
    const peers = cache.status?.peers ?? [];
    openSheet({
      title: "新建群聊",
      body: `<form class="form" data-form="new-group">
        <div class="field"><label for="group-name">群名</label><input id="group-name" name="name" maxlength="40" placeholder="例如：周末实验室" /></div>
        <div class="section-title" style="padding-left:0">成员</div>
        ${peers.length
          ? peers.map((peer) => `<label class="switch-row" style="border-bottom:1px solid var(--line)">
              <input type="checkbox" name="peer" value="${escapeHtml(peer.nodeId)}" style="width:20px;height:20px;min-height:0;flex:0 0 auto" />
              <span class="row-main"><span class="row-name">${escapeHtml(peer.name || briefId(peer.nodeId))}</span><span class="row-sub">${escapeHtml(briefId(peer.nodeId))}</span></span>
            </label>`).join("")
          : '<div class="panel-note">还没有好友可以拉进群。先邀请朋友配对。</div>'}
        <div class="field err hidden" data-role="form-error"></div>
        <button class="btn primary block" type="submit">创建群聊</button>
      </form>`,
    });
  },
  "group-members"(el) {
    openGroupMembersSheet(el.dataset.id);
  },
  async "group-kick"(el) {
    const { id, node, name } = el.dataset;
    const ok = await confirmDialog({
      title: "移出群聊？",
      text: `把「${name || "该成员"}」移出这个群？群成员少于 3 人时群会自动解散。`,
      confirmLabel: "移出",
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await api(`/api/federation/groups/${encodeURIComponent(id)}/members/remove`, {
        method: "POST",
        body: JSON.stringify({ nodeId: node }),
      });
      cache.groups = null;
      if (data?.dissolved) {
        closeLayers();
        toast("已移出，群人数不足 3 人，群聊已解散");
        navigate({ kind: "groups" }, { replace: true });
        return;
      }
      toast("已移出群聊");
      openGroupMembersSheet(id);
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "group-leave"(el) {
    const ok = await confirmDialog({
      title: "退出群聊？",
      text: "退出后这个群会从本机移除，聊天记录不再显示；群成员少于 3 人时群会自动解散。",
      confirmLabel: "退出",
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await api(`/api/federation/groups/${encodeURIComponent(el.dataset.id)}/leave`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      cache.groups = null;
      closeLayers();
      toast(data?.dissolved ? "已退出，群人数不足 3 人，群聊已解散" : "已退出群聊");
      navigate({ kind: "groups" }, { replace: true });
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async "group-dissolve"(el) {
    const ok = await confirmDialog({
      title: "解散群聊？",
      text: "所有成员都会收到解散通知，聊天记录保留在本地。",
      confirmLabel: "解散",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/federation/groups/${encodeURIComponent(el.dataset.id)}/dissolve`, { method: "POST", body: JSON.stringify({}) });
      cache.groups = null;
      closeLayers();
      toast("群聊已解散");
      navigate({ kind: "groups" }, { replace: true });
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  "guest-create"() {
    const conversations = cache.conversations ?? [];
    if (!conversations.length) {
      toast("先新建一个 Agent", "error");
      return;
    }
    closeLayers();
    openSheet({
      title: "生成访客链接",
      body: `<form class="form" data-form="guest-create">
        <div class="field"><label for="guest-char">哪个 Agent</label>
          <select id="guest-char" name="characterId">${conversations.map((item) => `<option value="${escapeHtml(item.characterId)}">${escapeHtml(item.name)}</option>`).join("")}</select>
        </div>
        <div class="field"><label for="guest-label">标签（可选）</label><input id="guest-label" name="label" placeholder="例如：给小王看" /></div>
        <div class="field"><label for="guest-ttl">有效期</label>
          <select id="guest-ttl" name="ttlHours">
            <option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天</option>
          </select>
        </div>
        <div class="field err hidden" data-role="form-error"></div>
        <button class="btn primary block" type="submit">生成</button>
      </form>`,
    });
  },
  async "guest-revoke"(el) {
    const ok = await confirmDialog({ title: "撤销访客链接？", text: "撤销后这个链接立刻失效。", confirmLabel: "撤销", danger: true });
    if (!ok) return;
    try {
      await api(`/api/guest-tokens/${encodeURIComponent(el.dataset.id)}/revoke`, { method: "POST", body: JSON.stringify({}) });
      cache.guests = null;
      toast("已撤销");
      render();
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  "postcard-create"() {
    const conversations = cache.conversations ?? [];
    const peers = cache.status?.peers ?? [];
    closeLayers();
    if (!peers.length) {
      toast("还没有好友可寄", "error");
      return;
    }
    openSheet({
      title: "写一张明信片",
      body: `<form class="form" data-form="postcard">
        <div class="field"><label for="pc-peer">寄给</label>
          <select id="pc-peer" name="nodeId">${peers.map((peer) => `<option value="${escapeHtml(peer.nodeId)}">${escapeHtml(peer.name || briefId(peer.nodeId))}</option>`).join("")}</select>
        </div>
        <div class="field"><label for="pc-fish">哪个 Agent 写的</label>
          <select id="pc-fish" name="character">${conversations.map((item) => `<option value="${escapeHtml(item.characterId)}">${escapeHtml(item.name)}</option>`).join("")}</select>
        </div>
        <div class="field"><label for="pc-text">正文</label><textarea id="pc-text" name="text" rows="4" maxlength="2000" placeholder="写点什么…"></textarea></div>
        <div class="field err hidden" data-role="form-error"></div>
        <button class="btn primary block" type="submit">寄出</button>
      </form>`,
    });
  },
  "toggle-plugin"(el) {
    togglePlugin(el.dataset.id);
  },
  "toggle-safe"() {
    toggleSafe();
  },
  "toggle-sfx"(el) {
    // 开关音自己播（全局委托里已对 toggle-sfx 提前 return）
    const on = el.classList.contains("on"); // 点击前
    const next = !on;
    if (next) {
      sfx.setMuted(false);
      void sfx.play("ui_toggle_on");
    } else {
      void sfx.play("ui_toggle_off");
      // 等"关"这一声播完再静音，否则 10ms 内主增益就滑到 0 了
      setTimeout(() => { if (!el.classList.contains("on")) sfx.setMuted(true); }, 140);
    }
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
  },
  "sfx-volume"() {
    const levels = [0.4, 0.7, 1.0];
    const index = levels.findIndex((value) => Math.abs(value - sfx.volume) < 0.01);
    const next = levels[(index + 1) % levels.length];
    sfx.setVolume(next);
    void sfx.play("ui_click");
    toast(`音效音量 ${Math.round(next * 100)}%`);
    render();
  },
  "device-cmd"(el) {
    const { id, command, param, label } = el.dataset;
    if (!param) {
      runDeviceCommand(id, command, {});
      return;
    }
    const placeholder = param === "celsius" ? "例如 24" : "0–100";
    openSheet({
      title: `${label} · ${param}`,
      body: `<form class="form" data-form="device-cmd" data-id="${escapeHtml(id)}" data-command="${escapeHtml(command)}" data-param="${escapeHtml(param)}">
        <div class="field"><label for="dv-value">数值</label><input id="dv-value" name="value" type="number" step="1" placeholder="${escapeHtml(placeholder)}" required /></div>
        <button class="btn primary block" type="submit">执行</button>
      </form>`,
    });
  },
  "plugin-purge"(el) {
    confirmDialog({
      title: "清空插件存储？",
      text: "删除这个插件自己保存的数据，不可恢复。",
      confirmLabel: "清空",
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      try {
        await api(`/api/plugins/${encodeURIComponent(el.dataset.id)}/storage`, { method: "DELETE" });
        toast("插件存储已清空");
      } catch (error) {
        toast(errorText(error), "error");
      }
    });
  },
  async snapshot(el) {
    try {
      await api(`/api/characters/${encodeURIComponent(el.dataset.id)}/snapshot`, { method: "POST", body: JSON.stringify({}) });
      toast("已生成状态快照");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async recover(el) {
    const ok = await confirmDialog({
      title: "从事件日志重建状态？",
      text: "会用 events 重新计算 mood / energy / unread 等状态，事件本身不会丢。",
      confirmLabel: "重建",
    });
    if (!ok) return;
    try {
      await api(`/api/characters/${encodeURIComponent(el.dataset.id)}/recover`, { method: "POST", body: JSON.stringify({}) });
      toast("状态已重建");
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  async snapshots(el) {
    try {
      const data = await api(`/api/characters/${encodeURIComponent(el.dataset.id)}/snapshots`);
      const list = data.snapshots ?? [];
      openSheet({
        title: `${el.dataset.name ?? "这个 Agent"} · 快照`,
        body: list.length
          ? `<div class="sheet-body">${list.slice().reverse().map((name) => `<div class="sheet-row" style="cursor:default"><span class="mono">${escapeHtml(name)}</span></div>`).join("")}</div>`
          : `<div class="panel-note">还没有快照。先点「拍快照」。</div>`,
      });
    } catch (error) {
      toast(errorText(error), "error");
    }
  },
  copy(el) {
    copyText(el.dataset.text ?? "");
  },
  "open-help"() {
    openSheet({
      title: "帮助",
      body: `<div class="card" style="margin:8px 0">
        <h3>怎么用</h3>
        <p>· 底部四个入口：消息 / 通讯录 / 发现 / 我。<br />
           · 点任意列表行进入下一页，左上「‹」或系统返回键退回。<br />
           · 聊天页输入后回车发送，Shift+回车换行。<br />
           · 桌面端（≥900px）左侧是导航，中间是列表，右边是内容。</p>
      </div>
      <div class="card" style="margin:8px 0">
        <h3>数据在哪</h3>
        <p>都在本机 v2/data 下。事件日志是唯一真相；「备份与恢复」可以从事件重建状态。</p>
      </div>
      <div class="card" style="margin:8px 0">
        <h3>出问题</h3>
        <p>先看 Hub 是否在运行（/api/health），再试旧控制台 /v2 定位。错误提示会显示在对应页面里，可点「重试」。</p>
      </div>`,
    });
  },
};

function clearLayers() {
  closeLayers();
}

const FORMS = {
  "new-fish": submitNewFish,
  profile: submitProfile,
  chat: sendChat,
  "group-chat": sendGroupChat,
  connect: submitConnect,
  "guest-create": submitGuest,
  postcard: submitPostcard,
  "new-group": submitNewGroup,
  "plugin-perms": submitPluginPerms,
  "human-chat": submitHumanChat,
  "device-cmd": submitDevice,
};

/* ======================================================================
 * 15. 输入交互
 * ==================================================================== */

function autoGrow(area) {
  if (!area) return;
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight, 112)}px`;
}

function updateSendButton(form) {
  const area = $("textarea", form);
  const button = $(".send-btn", form);
  if (!area || !button) return;
  button.classList.toggle("can-send", Boolean(area.value.trim()));
}

let filterTimer = 0;

function handleComposerInput(area) {
  autoGrow(area);
  const form = area.closest("form");
  if (form) updateSendButton(form);
  const kind = form?.dataset.form === "group-chat" ? "group:" : "";
  const id = form?.dataset.id ?? "";
  if (form) ui.drafts[`${kind}${id}`] = area.value;
}

/* ======================================================================
 * 16. 启动
 * ==================================================================== */

const SCREEN_DEFS = {
  messages: { title: "VRlink", body: messagesBody },
  chat: { title: "聊天", body: chatBody, chat: true },
  remote: { title: "聊天", body: remoteChatBody, chat: true, composer: "remote" },
  fish: { title: "资料", body: fishBody },
  new: { title: "新建 Agent", body: newAgentBody },
  contacts: { title: "通讯录", body: contactsBody },
  pending: { title: "新的朋友", body: pendingBody },
  peer: { title: "好友", body: peerBody },
  groups: { title: "群聊", body: groupsBody },
  group: { title: "群聊", body: groupBody, chat: true, composer: "group" },
  invite: { title: "邀请朋友", body: inviteBody },
  guest: { title: "只读访客", body: guestBody },
  postcards: { title: "明信片", body: postcardsBody },
  discover: { title: "发现", body: discoverBody },
  devices: { title: "设备", body: devicesBody },
  plugins: { title: "插件", body: pluginsBody },
  plugin: { title: "插件详情", body: pluginBody },
  me: { title: "我", body: meBody },
  identity: { title: "节点身份", body: identityBody },
  safe: { title: "安全模式", body: safeBody },
  backup: { title: "备份与恢复", body: backupBody },
  version: { title: "版本与发行版", body: versionBody },
  advanced: { title: "高级", body: advancedBody },
};

async function prime() {
  await Promise.allSettled([
    loaders.conversations(),
    loaders.pending(),
    loaders.status(),
    loaders.identity(),
    loaders.safeMode(),
    loaders.humanSelf(),
  ]);
  const active = document.activeElement;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
  if (!typing) render();
  playUiReady();
}

function bindGlobalEvents() {
  // ---- 界面音效：点击 / 开关（capture 阶段，先于业务 handler，读到改前状态） ----
  document.addEventListener("click", (event) => {
    const el = event.target.closest?.(
      ".switch, [data-role='ok'], [data-role='cancel'], [data-act], [data-go], [data-back], .btn, .row, .sheet-row, .chip",
    );
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;

    // 开关：用点击前的 aria-checked 决定开/关音；音效总开关自己处理，避免叠音
    if (el.classList.contains("switch")) {
      if (el.dataset.act === "toggle-sfx") return;
      void sfx.play(el.getAttribute("aria-checked") === "true" ? "ui_toggle_off" : "ui_toggle_on");
      return;
    }
    if (el.dataset.role === "ok") { void sfx.play("ui_confirm"); return; }
    if (el.dataset.role === "cancel") { void sfx.play("ui_click_soft"); return; }
    // 危险动作：删除 / 撤销 / 退群 / 解散 / 拒绝 / 断开
    const act = el.dataset.act || "";
    if (el.classList.contains("danger") || /^(delete|remove|revoke|purge|leave|dissolve|reject|disconnect)/.test(act)) {
      void sfx.play("ui_cancel");
      return;
    }
    void sfx.play(el.classList.contains("primary") ? "ui_click" : "ui_click_soft");
  }, true);

  document.addEventListener("click", (event) => {
    const actionEl = event.target.closest?.("[data-act]");
    if (actionEl) {
      const fn = ACTIONS[actionEl.dataset.act];
      if (fn) {
        event.preventDefault();
        Promise.resolve(fn(actionEl, event)).catch((error) => toast(errorText(error), "error"));
        return;
      }
    }
    const goEl = event.target.closest?.("[data-go]");
    if (goEl) {
      event.preventDefault();
      closeLayers();
      navigate(goEl.dataset.go);
      return;
    }
    const backEl = event.target.closest?.("[data-back]");
    if (backEl) {
      event.preventDefault();
      closeLayers();
      goBack();
    }
  });

  // 发送按钮是 type=submit：按下时浏览器会把焦点从输入框挪到按钮，
  // 手机上键盘随之收起。拦掉 mousedown 的默认行为，焦点留在输入框，键盘不收。
  document.addEventListener("mousedown", (event) => {
    const button = event.target.closest?.(".composer .send-btn");
    if (button) event.preventDefault();
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target.closest?.("[data-form]");
    if (!form) return;
    event.preventDefault();
    const fn = FORMS[form.dataset.form];
    if (!fn) return;
    Promise.resolve(fn(form)).catch((error) => toast(errorText(error), "error"));
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches(".composer textarea")) {
      handleComposerInput(target);
      return;
    }
    if (target.dataset.role === "net-link") {
      netUI.join.link = target.value;
      return;
    }
    if (target.dataset.filter === "messages") {
      ui.searchQuery = target.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        render();
        const input = $('[data-filter="messages"]');
        if (input) {
          input.focus();
          const end = input.value.length;
          input.setSelectionRange(end, end);
        }
      }, 200);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.role === "device-char") ui.deviceChar = target.value;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLayers();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      const area = event.target;
      if (area instanceof HTMLElement && area.matches(".composer textarea")) {
        event.preventDefault();
        area.closest("form")?.requestSubmit();
      }
    }
  });

  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains("screen-body")) {
        const key = target.dataset.key;
        if (key) ui.scroll[key] = target.scrollTop;
      }
    },
    true,
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    cache.conversations = null;
    cache.status = null;
    cache.pending = null;
    cache.groups = null;
    cache.humanThreads = null;
    scheduleRender();
  });

  function syncViewportHeight() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
  }
  syncViewportHeight();
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.visualViewport?.addEventListener("scroll", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);

  window.addEventListener("popstate", () => {
    ui.dir = "back";
    scheduleRender();
  });
  window.addEventListener("hashchange", () => {
    ui.dir = "back";
    scheduleRender();
  });

  const media = window.matchMedia("(min-width: 900px)");
  const onChange = () => scheduleRender();
  if (media.addEventListener) media.addEventListener("change", onChange);
  else media.addListener(onChange);
}

/* ---- 全局 SSE：人-人 / 群聊 / 列表 / 配对 / 资料 即时推送（v0.6.0） ---- */
function connectUiEvents() {
  if (typeof EventSource === "undefined") return;
  let source;
  try {
    source = new EventSource("/api/events");
  } catch {
    return;
  }
  ui.events = source;
  const parse = (event) => {
    try {
      return JSON.parse(event.data || "{}");
    } catch {
      return {};
    }
  };
  source.addEventListener("human", (event) => {
    const data = parse(event);
    cache.humanThreads = null;
    const inThatChat = ui.route?.kind === "remote" && ui.route.nodeId === data.nodeId;
    if (inThatChat) {
      ui.liveRefresh?.();
    } else if (!data.fromSelf && !document.hidden && performance.now() - lastMsgSoundAt > 900) {
      // 不在那个会话里：给一声"新消息"提示（用户可能停在别的页面）；自己发的不响
      lastMsgSoundAt = performance.now(); // 让列表兜底轮询别重复响
      void sfx.play("ui_confirm", { minGap: 1.5, volume: 0.7 });
    }
    ui.listRefresh?.();
  });
  source.addEventListener("group", (event) => {
    const data = parse(event);
    cache.groups = null;
    const inThatGroup = ui.route?.kind === "group" && ui.route.id === data.groupId;
    if (inThatGroup) {
      ui.groupRefresh?.();
    } else if (!data.fromSelf && !document.hidden && performance.now() - lastMsgSoundAt > 900) {
      lastMsgSoundAt = performance.now();
      void sfx.play("ui_confirm", { minGap: 1.5, volume: 0.7 });
    }
    ui.listRefresh?.();
  });
  source.addEventListener("groups", () => {
    cache.groups = null;
    if (ui.route?.kind === "group") ui.groupRefresh?.();
    ui.listRefresh?.();
  });
  source.addEventListener("list", () => {
    cache.conversations = null;
    if (ui.route?.kind === "messages") ui.listRefresh?.();
  });
  source.addEventListener("pending", () => {
    cache.pending = null;
    if (ui.route?.kind === "contacts" || ui.route?.kind === "pending") render();
  });
  source.addEventListener("profile", () => {
    cache.humanThreads = null;
    cache.status = null;
  });
  source.addEventListener("status", () => {
    cache.status = null;
  });
  source.onerror = () => {
    /* EventSource 自带重连；1.5s/3s 轮询仍作为兜底 */
  };
}

function boot() {
  if (!location.hash || location.hash === "#" || location.hash === "#/") {
    history.replaceState({ wx: true, wxDepth: 1, wxDirect: true }, "", "#/messages");
  } else {
    history.replaceState(
      { wx: true, wxDepth: buildChain(parseRoute()).length, wxDirect: true },
      "",
      location.hash,
    );
  }
  bindGlobalEvents();
  connectUiEvents();
  render();
  prime();
  // 空闲时预解码常用音效，首次点击零延迟（只解码用到的 10 个）
  sfx.preload([
    "ui_click", "ui_click_soft", "ui_toggle_on", "ui_toggle_off",
    "ui_msg_in", "ui_msg_out", "ui_ready", "ui_error", "ui_confirm", "ui_cancel",
  ]).catch(() => {});
}

boot();

