import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

export const model: Model<Api> = buildModel({
  id: "title-model", name: "Retitle Offline Test", provider: "retitle-test", api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/never-connect",
  reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
export function reply(text = "[-][enhancement][implement] OMP 会话手动重命名"): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
