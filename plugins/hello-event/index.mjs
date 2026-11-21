// 最小示例：只订阅事件、只写日志。
// 不依赖任何外部服务，不需要 storage / messages.send 权限。
export default function activate(api) {
  api.log("info", "hello-event 已启动：我只读事件，不写任何数据。");

  api.on("event", (name, event) => {
    api.log("info", `${event?.type ?? name} @ ${event?.characterId ?? "?"}`);
  });
}
