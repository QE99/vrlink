// VRlink v2 插件模板（apiVersion 1）
//
// 宿主会在独立子进程里 import 这个文件，并调用 default export 的 activate(api)。
// 可用 API：api.id / api.permissions / api.on / api.log / api.send / api.storage。
// 没有 memory / capabilities / network / devices API —— 那些权限名目前只是清单预留。
//
// 复制本目录后的最小改动：
//   1. 改 plugin.json 的 id、name（id 必须唯一，且匹配 ^[a-z0-9][a-z0-9_-]{1,40}$）
//   2. 在 permissions 里只保留真正需要的权限
//   3. 在 v2 UI 插件页点“启用”，或在命令行 POST /api/plugins/<id>/enable

let localCount = 0; // storage 权限被撤销时的内存兜底计数

export default async function activate(api) {
  api.log("info", `插件模板已启动；本次授权：${api.permissions.join(", ") || "无"}`);

  api.on("event", async (name, event) => {
    // 只处理聊天消息；别的类型直接忽略（也避免收到自己发的 message.sent 后无限自激）。
    if (!event || event.type !== "message.received") return;

    let count;
    try {
      count = Number((await api.storage.get("received")) ?? 0) + 1;
      api.storage.set("received", count); // fire-and-forget：宿主负责落盘
    } catch (error) {
      count = ++localCount;
      api.log("warn", `存储不可用，本次只在内存里计数：${error.message}`);
    }

    const text = String(event.content?.text ?? "").slice(0, 40);
    const source = event.source?.body ?? "desktop";
    api.log("info", `收到 ${event.characterId} 的消息（第 ${count} 条，来自 ${source}）：${text}`);

    // 需要 messages.send 权限，并且目标角色要有覆盖 message.send 的低风险同意。
    // 发送失败不会抛错到插件里，只会在宿主日志里留下 “send denied / send failed”。
    api.send({
      characterId: event.characterId,
      text: `[模板] 我收到第 ${count} 条消息了。`,
      target: { body: "desktop", thread: "plugin-template", visibility: "private" },
    });
  });
}
