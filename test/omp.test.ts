import { expect, test } from "bun:test";
import { Effort, type Context, type Model, type Api, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { parseConfig } from "../src/config.ts";
import { generateTitle, projectBranch, type GenerationContext, type Complete } from "../src/omp.ts";
import { buildTitleInput } from "../src/title-policy.ts";
import { model, reply } from "./fixtures/model.ts";

const input = buildTitleInput([], "实现 OMP 会话标题刷新", "old", 4000);
function fixture() {
  const resolved: { model: Model<Api>; session?: string; signal?: AbortSignal }[] = [];
  const requests: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
  const ctx: GenerationContext = {
    model,
    sessionId: "main-session",
    modelRegistry: {
      find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      getApiKey: async (selected, session, options) => {
        resolved.push({ model: selected, session, signal: options?.signal });
        return "isolated-test-key";
      },
      getProviderHeaders: () => ({ "X-Test-Provider": "configured" }),
    },
  };
  const complete: Complete = async (selected, context, options) => {
    requests.push({ model: selected, context, options });
    return reply();
  };
  return { ctx, complete, resolved, requests };
}

test("one credential resolution uses the main session, while the request has independent context and transport identity", async () => {
  const h = fixture();
  const signal = new AbortController().signal;
  expect(await generateTitle(h.ctx, parseConfig({}), input, "RETITLE-ONLY RULES", signal, h.complete)).toBe("[-][enhancement][implement] OMP 会话手动重命名");
  expect(h.resolved).toHaveLength(1);
  expect(h.resolved[0]).toEqual({ model, session: "main-session", signal });
  const request = h.requests[0]!;
  expect(request.context.systemPrompt).toEqual(["RETITLE-ONLY RULES"]);
  expect(request.context.messages).toHaveLength(1);
  expect(request.context.messages[0]).toMatchObject({ role: "user", content: input.text });
  expect(request.context.tools).toEqual([]);
  expect(request.model).toEqual(model);
  expect(request.model).not.toBe(model);
  expect(request.options.apiKey).toBe("isolated-test-key");
  expect(request.options.headers).toEqual({ "X-Test-Provider": "configured" });
  expect(request.options.sessionId).toStartWith("omp-retitle-");
  expect(request.options.sessionId).not.toBe(h.ctx.sessionId);
  expect(request.options.statefulResponses).toBe(false);
  expect(request.options.providerSessionState).toBeUndefined();
  expect(request.options.promptCacheKey).toBeUndefined();
  expect(request.options.reasoning).toBeUndefined();
  expect(request.options.disableReasoning).toBe(true);
  expect(h.ctx.model).toBe(model);
});

test("explicit model and reasoning are independent of the main model", async () => {
  const h = fixture();
  h.ctx.model = { ...model, id: "main-model", provider: "main-provider" };
  await generateTitle(h.ctx, parseConfig({ model: { provider: model.provider, id: model.id }, reasoning: "low", maxOutputTokens: 4096 }), input, "rules", new AbortController().signal, h.complete);
  expect(h.requests[0]!.model.id).toBe("title-model");
  expect(h.requests[0]!.model.baseUrl).toBe(model.baseUrl);
  expect(h.requests[0]!.options.reasoning).toBe(Effort.Low);
  expect(h.requests[0]!.options.disableReasoning).toBeUndefined();
  expect(h.requests[0]!.options.maxTokens).toBe(4096);
  expect(h.ctx.model.id).toBe("main-model");
});

for (const failure of ["missing-model", "alias", "missing-auth", "unsupported-reasoning", "output-limit", "context-limit"]) {
  test(`invalid request never calls the transport: ${failure}`, async () => {
    const h = fixture();
    let config = parseConfig({});
    if (failure === "missing-model") h.ctx.model = undefined;
    if (failure === "alias") config = parseConfig({ model: { provider: model.provider, id: "alias" } });
    if (failure === "alias") h.ctx.modelRegistry.find = () => model;
    if (failure === "missing-auth") h.ctx.modelRegistry.getApiKey = async () => undefined;
    if (failure === "unsupported-reasoning") { h.ctx.model = { ...model, reasoning: false }; config = parseConfig({ reasoning: "high" }); }
    if (failure === "output-limit") h.ctx.model = { ...model, maxTokens: 512 };
    if (failure === "context-limit") h.ctx.model = { ...model, contextWindow: 100 };
    await expect(generateTitle(h.ctx, config, input, "rules", new AbortController().signal, h.complete)).rejects.toThrow();
    expect(h.requests).toHaveLength(0);
  });
}

test("nullable catalog limits are accepted without fabricating capacities", async () => {
  const h = fixture();
  h.ctx.model = { ...model, maxTokens: null, contextWindow: null };
  await generateTitle(h.ctx, parseConfig({}), input, "rules", new AbortController().signal, h.complete);
  expect(h.requests).toHaveLength(1);
});

for (const reason of ["error", "length", "aborted", "toolUse"] as const) {
  test(`partial or failed model completion is never accepted: ${reason}`, async () => {
    const h = fixture();
    const response = reply();
    response.stopReason = reason;
    response.errorMessage = "Authorization: secret-test-only";
    await expect(generateTitle(h.ctx, parseConfig({}), input, "rules", new AbortController().signal, async () => response)).rejects.toThrow();
  });
}

test("thinking is not used as output, and tool calls are rejected even with stop", async () => {
  const h = fixture();
  const response = reply();
  response.content.unshift({ type: "thinking", thinking: "hidden reasoning" });
  expect(await generateTitle(h.ctx, parseConfig({}), input, "rules", new AbortController().signal, async () => response)).not.toContain("hidden");
  response.content.push({ type: "toolCall", id: "test-call", name: "write", arguments: {} });
  await expect(generateTitle(h.ctx, parseConfig({}), input, "rules", new AbortController().signal, async () => response)).rejects.toThrow();
});

test("cancelling while resolving credentials stops the subsequent model call", async () => {
  const h = fixture();
  const controller = new AbortController();
  h.ctx.modelRegistry.getApiKey = async () => { controller.abort(); return "test"; };
  await expect(generateTitle(h.ctx, parseConfig({}), input, "rules", controller.signal, h.complete)).rejects.toThrow();
  expect(h.requests).toHaveLength(0);
});

test("visible branch projection excludes tools, images, thinking, and custom messages", () => {
  const base = { id: "e", parentId: null, timestamp: "2026-09-11T00:00:00Z" };
  const entries: SessionEntry[] = [
    { ...base, type: "message", message: { role: "user", content: [{ type: "text", text: "直接任务" }, { type: "image", data: "secret-image", mimeType: "image/png" }], timestamp: 0 } },
    { ...base, id: "a", type: "message", message: { ...reply("可见结果"), content: [{ type: "thinking", thinking: "secret-reasoning" }, { type: "text", text: "可见结果" }] } },
    { ...base, id: "t", type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "secret-tool-output PR#999" }], isError: false, timestamp: 0 } },
    { ...base, id: "custom", type: "custom", customType: "irrelevant", data: "secret-custom" },
    { ...base, id: "s", type: "branch_summary", fromId: "old", summary: "低信任摘要" },
  ];
  expect(projectBranch(entries)).toEqual([
    { id: "e", role: "user", text: "直接任务" },
    { id: "a", role: "assistant", text: "可见结果" },
    { id: "s", role: "summary", text: "低信任摘要" },
  ]);
  expect(projectBranch([...entries, { ...base, id: "clear", type: "reset_boundary" }])).toEqual([]);
});
