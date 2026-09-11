import { randomUUID } from "node:crypto";
import { completeSimple, Effort, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ModelRegistry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { RetitleConfig } from "./config.ts";
import { RetitleError, type TranscriptItem, type TitleInput } from "./title-policy.ts";

export interface GenerationContext {
  model: Model<Api> | undefined;
  modelRegistry: Pick<ModelRegistry, "find" | "getApiKey" | "getProviderHeaders">;
  sessionId: string;
}
export type Complete = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;
const EFFORTS = { minimal: Effort.Minimal, low: Effort.Low, medium: Effort.Medium, high: Effort.High, xhigh: Effort.XHigh, max: Effort.Max };

/** No tools, thinking blocks, images, encrypted replay, or custom messages. */
export function projectBranch(entries: readonly SessionEntry[]): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type === "reset_boundary") {
      result.length = 0;
    } else if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      if (text.trim()) result.push({ id: entry.id, role: entry.message.role, text });
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      result.push({ id: entry.id, role: "summary", text: entry.summary });
    }
  }
  return result;
}

/** A standalone request, not a prompt sent to the main AgentSession. */
export async function generateTitle(
  ctx: GenerationContext,
  config: RetitleConfig,
  input: TitleInput,
  system: string,
  signal: AbortSignal,
  complete: Complete = completeSimple,
): Promise<string> {
  signal.throwIfAborted();
  const model = config.model ? ctx.modelRegistry.find(config.model.provider, config.model.id) : ctx.model;
  if (!model || (config.model && (model.provider !== config.model.provider || model.id !== config.model.id))) {
    throw new RetitleError("The exact provider/model was not found; no fallback model was selected.");
  }
  if (config.reasoning !== "off" && !model.reasoning) throw new RetitleError("This model does not support reasoning; set reasoning to off.");
  if (model.maxTokens !== null && config.maxOutputTokens > model.maxTokens) throw new RetitleError("maxOutputTokens exceeds the model's output limit.");
  // Conservative byte budget, not a tokenizer or a promise about token cost.
  if (model.contextWindow !== null && Buffer.byteLength(system + input.text) + config.maxOutputTokens > model.contextWindow) {
    throw new RetitleError("The conservative input budget exceeds the model's context window; reduce maxInputChars or shorten the title rules.");
  }
  // Same session identity for OMP's native credential selection, but NO rotating
  // resolver: retrying this auxiliary call must not actively rotate the main pool.
  const apiKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionId, { signal });
  signal.throwIfAborted();
  if (apiKey === undefined) throw new RetitleError("No authentication is available for this model; configure its provider in OMP first.");
  const result = await complete({ ...model }, {
    systemPrompt: [system],
    messages: [{ role: "user", content: input.text, timestamp: Date.now() }],
    tools: [],
  }, {
    apiKey,
    headers: ctx.modelRegistry.getProviderHeaders(model.provider),
    signal,
    sessionId: `omp-retitle-${randomUUID()}`,
    statefulResponses: false,
    maxTokens: config.maxOutputTokens,
    ...(config.reasoning === "off" ? { disableReasoning: true } : { reasoning: EFFORTS[config.reasoning] }),
  });
  signal.throwIfAborted();
  if (result.stopReason !== "stop" || result.content.some(part => part.type === "toolCall")) {
    // Provider error text may contain request bodies or credentials; never echo it.
    throw new RetitleError("The title model did not complete normally (error, truncation, cancellation, or tool call); the previous title is unchanged.");
  }
  return result.content.filter(part => part.type === "text").map(part => part.text).join("");
}
