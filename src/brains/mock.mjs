// Mock brain: deterministic, no network. Good for tests and the first UI.
export function createMockBrain() {
  return {
    async generate({ character, event, context }) {
      const text = String(event.content?.text ?? "").trim();
      const memoryCount = context.filter((item) => item.type === "message.received").length;
      const lines = [];
      if (!text) lines.push("……嗯，我在。");
      else if (/累|困|加班|夜班/.test(text)) lines.push("……先坐下。别急着说话。");
      else if (/在吗|在不在/.test(text)) lines.push("在。刚醒。");
      else if (/吃|饭/.test(text)) lines.push("吃了没？别又糊弄。");
      else lines.push(`（${character.name}看了你一眼）……嗯，${text.slice(0, 18)}。`);
      return {
        text: lines.join(""),
        thought: `收到第 ${memoryCount} 条消息；人设=${character.persona?.identity ?? "unknown"}`,
      };
    },
  };
}
