import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { model, reply } from "./model.ts";

/** Offline only: emits a canned answer without calling fetch or any provider. */
export default function mockProvider(pi: ExtensionAPI): void {
  pi.registerProvider("retitle-test", {
    api: "retitle-offline-test",
    baseUrl: "http://127.0.0.1:1/never-connect",
    apiKey: "isolated-test-key",
    models: [{
      id: model.id, name: model.name, reasoning: true, input: ["text"],
      contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple: (_model, context, options) => {
      console.error("RETITLE_OFFLINE_MOCK_CALL");
      if (!options?.sessionId?.startsWith("omp-retitle-") || context.messages.length !== 1 || context.tools?.length) {
        throw new Error("The runtime attempted a main-agent request, not isolated retitling.");
      }
      const stream = createAssistantMessageEventStream();
      const title = context.systemPrompt?.some(part => part.startsWith("PROJECT POLICY")) ? "Project policy title" : "Refresh session titles";
      const message = { ...reply(`<title>${title}</title>`), api: "retitle-offline-test" };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
}
