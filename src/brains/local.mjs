// Local llama.cpp brain. Speaks the OpenAI-compatible /v1/chat/completions endpoint
// exposed by llama-server. No cloud, no token bill; caller owns the runtime.
import { buildMessages } from "./openai.mjs";

/**
 * 接受两种常见写法：
 *   http://127.0.0.1:8080        → http://127.0.0.1:8080/v1/chat/completions
 *   http://127.0.0.1:8080/v1     → http://127.0.0.1:8080/v1/chat/completions
 * （和 openai 大脑的 baseUrl 语义对齐，玩家从云模型切到本地模型时不用改地址习惯）
 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function createLocalBrain({
  baseUrl = process.env.VRLINK_LOCAL_BASE_URL || "http://127.0.0.1:12345",
  apiKey = process.env.VRLINK_LOCAL_API_KEY || "",
  model = process.env.VRLINK_LOCAL_MODEL || "",
  temperature = 0.7,
  maxTokens = 700,
  disableThinking = process.env.VRLINK_LOCAL_DISABLE_THINKING !== "0",
  repeatPenalty = Number(process.env.VRLINK_LOCAL_REPEAT_PENALTY || 1.1),
  fetchImpl = fetch,
} = {}) {
  return {
    async generate({ character, event, context, memories = [] }) {
      const messages = buildMessages({ character, event, context, memories });
      const body = {
        messages,
        temperature,
        max_tokens: maxTokens,
        repeat_penalty: repeatPenalty,
        stream: false,
      };
      if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };
      if (model) body.model = model;
      let response;
      try {
        response = await fetchImpl(chatCompletionsUrl(baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new Error(`本地模型连不上（${baseUrl}）：${error?.message ?? error}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`本地模型 HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("本地模型返回空内容");
      return { text };
    },
  };
}
