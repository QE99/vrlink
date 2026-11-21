// OpenAI-compatible brain. Works with DeepSeek/Kimi/OpenAI-compatible endpoints.
// Key is read from env only; never stored in character data.
export function createOpenAIBrain({
  baseUrl = process.env.VRLINK_BRAIN_BASE_URL || "https://api.deepseek.com",
  apiKey = process.env.VRLINK_BRAIN_API_KEY || "",
  model = process.env.VRLINK_BRAIN_MODEL || "deepseek-chat",
  temperature = 0.7,
  maxTokens = 700,
  fetchImpl = fetch,
} = {}) {
  return {
    async generate({ character, event, context, memories = [] }) {
      if (!apiKey) throw new Error("VRLINK_BRAIN_API_KEY is not set");
      const messages = buildMessages({ character, event, context, memories });
      const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`brain http ${response.status}: ${body.slice(0, 300)}`);
      }
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("brain returned empty content");
      return { text };
    },
  };
}

export function buildMessages({ character, event, context, memories = [] }) {
  const persona = character.persona ?? {};
  const memoryLines = memories
    .slice(-10)
    .map((memory) => `- ${String(memory.text ?? "").slice(0, 160)}`)
    .filter((line) => line.length > 2)
    .join("\n");
  const system = [
    `你在扮演「${character.name}」。`,
    persona.identity ? `身份：${persona.identity}` : "",
    persona.baseline ? `性格：${persona.baseline}` : "",
    Array.isArray(persona.quirks) && persona.quirks.length ? `小习惯：${persona.quirks.join("；")}` : "",
    memoryLines ? `你记得的事：\n${memoryLines}` : "",
    "规则：短句；不说自己是 AI；不解释设定；最多两三句。",
  ]
    .filter(Boolean)
    .join("\n");

  const recent = context
    .filter((item) => item.type === "message.received" || item.type === "message.sent")
    .slice(-10)
    .map((item) => ({
      role: item.type === "message.received" ? "user" : "assistant",
      content: String(item.content?.text ?? "").slice(0, 500),
    }))
    .filter((item) => item.content);

  const current = String(event.content?.text ?? "").slice(0, 2000);
  if (!recent.length || recent[recent.length - 1].content !== current) {
    recent.push({ role: "user", content: current });
  }
  return [{ role: "system", content: system }, ...recent];
}
