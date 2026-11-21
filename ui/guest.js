const root = document.getElementById("guest");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function time(at) {
  try {
    return new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function main() {
  const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() ?? "");
  if (!token) {
    root.className = "guest-error";
    root.textContent = "缺少访客 token。";
    return;
  }
  const response = await fetch(`/api/guest/${encodeURIComponent(token)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    root.className = "guest-error";
    root.textContent = data.error ?? "访客链接已失效。";
    return;
  }
  const guest = data.guest;
  document.title = `${guest.name} · VRlink 只读访客`;
  root.className = "";
  root.innerHTML = `
    <div class="card guest-card">
      <div class="guest-head">
        <span class="avatar">${escapeHtml(String(guest.name ?? "A").slice(0, 1))}</span>
        <div><h1>${escapeHtml(guest.name)}</h1><p>${escapeHtml(guest.identity || "TA 的隔离间")} · 只读</p></div>
      </div>
    </div>
    <div class="guest-banner">这是主人分享的只读生活流；不能聊天、不能看记忆、不能操作设备。</div>
    <div class="card guest-card">
      <div class="section-title" style="margin-top:0"><b>公开生活流</b><span>最近 ${guest.events?.length ?? 0} 条</span></div>
      ${(guest.events ?? []).map((event) => `<div class="guest-event"><span class="time">${time(event.at)}</span><span class="text">${escapeHtml(event.text || event.type)}</span></div>`).join("") || `<div class="empty">她还没有公开生活流。</div>`}
    </div>
    <div class="guest-foot">链接到期：${time(guest.expiresAt)}。主人撤销后立即失效。</div>`;
}

main().catch((error) => {
  root.className = "guest-error";
  root.textContent = `加载失败：${error.message}`;
});
