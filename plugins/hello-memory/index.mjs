// 示例插件入口（尚未由插件宿主执行；先作为契约/权限示例）。
// 未来的插件宿主会注入 api：on / log / send / memory / storage。
export default function activate(api) {
  api.on?.("event", async (event) => {
    if (event.type !== "message.received") return;
    if (!event.characterId) return;
    api.log?.("info", `收到 ${event.characterId} 的消息`);
  });
}
