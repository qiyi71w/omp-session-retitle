import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import type { RetitleConfig } from "./config.ts";
import { type generateTitle, type GenerationContext, projectBranch } from "./omp.ts";
import { buildTitleInput, RetitleError, validateTitle } from "./title-policy.ts";

export const JOURNAL_TYPE = "omp-session-retitle:undo:v1";
const STATUS_KEY = "omp-session-retitle";

type SessionView = Pick<ReadonlySessionManager, "getSessionId" | "getSessionFile" | "getCwd" | "getLeafId" | "getSessionName" | "getEntries" | "getBranch">;
export type RetitleContext = Pick<ExtensionContext, "cwd" | "mode" | "model" | "isIdle" | "hasPendingMessages"> & {
  sessionManager: SessionView;
  modelRegistry: GenerationContext["modelRegistry"];
  ui: Pick<ExtensionUIContext, "notify" | "setStatus" | "onTerminalInput">;
};
export interface RetitleDependencies {
  loadConfig(cwd: string): Promise<RetitleConfig>;
  loadRules(config: RetitleConfig): Promise<string>;
  generate: typeof generateTitle;
}
interface Snapshot {
  sessionId: string;
  file: string | undefined;
  cwd: string;
  leaf: string | null;
  title: string | undefined;
  titleVersion: string | null;
}
interface UndoState {
  version: 1;
  sessionId: string;
  previousTitle: string | null;
  appliedTitle: string;
  titleVersion: string | null;
}
interface Job {
  controller: AbortController;
  epoch: number;
  before: Snapshot;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  ctx: RetitleContext;
}

function snapshot(ctx: RetitleContext): Snapshot {
  const manager = ctx.sessionManager;
  const titleChanges = manager.getEntries().filter(entry => entry.type === "title_change");
  return {
    sessionId: manager.getSessionId(), file: manager.getSessionFile(), cwd: manager.getCwd(),
    leaf: manager.getLeafId(), title: manager.getSessionName(),
    titleVersion: titleChanges.at(-1)?.id ?? null,
  };
}
function same(a: Snapshot, b: Snapshot): boolean {
  return a.sessionId === b.sessionId && a.file === b.file && a.cwd === b.cwd && a.leaf === b.leaf && a.title === b.title && a.titleVersion === b.titleVersion;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function history(ctx: RetitleContext): UndoState | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE) continue;
    const data = entry.data;
    // Never inherit a parent's undo journal into a forked session.
    if (record(data) && typeof data.sessionId === "string" && data.sessionId !== ctx.sessionManager.getSessionId()) continue;
    if (!record(data) || typeof data.sessionId !== "string" || data.version !== 1 || typeof data.appliedTitle !== "string" ||
        !(data.previousTitle === null || (typeof data.previousTitle === "string" && !!data.previousTitle.trim())) ||
        !(data.titleVersion === null || typeof data.titleVersion === "string")) return undefined;
    return data as unknown as UndoState;
  }
  return undefined;
}

/** Settle locally on cancellation even when a provider ignores AbortSignal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new RetitleError("Title refresh cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** Owns generation, freshness checks, the write phase, and branch-local undo. */
export class RetitleController {
  private active?: Job;
  private epoch = 0;
  private committing = false;

  constructor(
    private readonly api: Pick<ExtensionAPI, "appendEntry" | "setSessionName">,
    private readonly deps: RetitleDependencies,
  ) {}

  /** Called BEFORE transitions too: switching away and back invalidates a job. */
  invalidate(): void {
    this.epoch++;
    if (!this.active) return;
    const job = this.active;
    job.controller.abort(new RetitleError("Session state changed; the pending title refresh was cancelled."));
    this.finish(job);
  }

  private finish(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.unsubscribe?.();
    job.unsubscribe = undefined;
    if (this.active === job) {
      job.ctx.ui.setStatus(STATUS_KEY, undefined);
      this.active = undefined;
    }
  }

  private owns(job: Job): boolean {
    return this.active === job && this.epoch === job.epoch && !job.controller.signal.aborted;
  }

  private fresh(job: Job): void {
    if (!this.owns(job) || !same(snapshot(job.ctx), job.before) || !job.ctx.isIdle() || job.ctx.hasPendingMessages()) {
      throw new RetitleError("Session, branch, title, or activity changed; the stale result was discarded.");
    }
  }

  private timeout(job: Job, ms: number): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => job.controller.abort(new RetitleError("Title generation timed out; the previous title is unchanged.")), Math.max(0, ms));
  }

  async handle(args: string, ctx: RetitleContext): Promise<void> {
    const command = args.trim();
    if (this.committing) {
      ctx.ui.notify("The title is being saved. Wait for the write to finish before retitle, undo, or cancel.", "warning");
      return;
    }
    const wasRunning = !!this.active;
    this.invalidate();
    if (command === "cancel") {
      ctx.ui.notify(wasRunning ? "Title refresh cancelled." : "No title refresh is running.", "info");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("Wait until the main session is idle and has no queued messages before refreshing its title.", "warning");
      return;
    }
    const before = snapshot(ctx);
    if (!before.title?.trim()) {
      ctx.ui.notify("This session has no title. OMP cannot undo back to an empty title; set one with /rename first.", "warning");
      return;
    }
    const job: Job = { controller: new AbortController(), epoch: this.epoch, before, ctx };
    this.active = job;
    const startedAt = Date.now();
    try {
      if (command === "undo") {
        const undo = history(ctx);
        if (!undo?.previousTitle || undo.appliedTitle !== before.title || undo.titleVersion !== before.titleVersion) {
          throw new RetitleError("No previous title can be safely restored on this branch; it may already have been undone or overwritten.");
        }
        await this.apply(job, undo.previousTitle, null);
        if (this.owns(job)) ctx.ui.notify("Previous title restored.", "info");
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, "Refreshing title… Esc or /retitle cancel to cancel");
      if (ctx.mode === "tui") {
        job.unsubscribe = ctx.ui.onTerminalInput(data => {
          if (data === "\u001b" && this.owns(job)) {
            this.invalidate();
            ctx.ui.notify("Title refresh cancelled.", "info");
            return { consume: true };
          }
          return undefined;
        });
      }
      // Includes config/rule I/O, not only the model request.
      this.timeout(job, 60000);
      const config = await abortable(this.deps.loadConfig(ctx.cwd), job.controller.signal);
      this.fresh(job);
      const remaining = config.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new RetitleError("Title generation timed out; the previous title is unchanged.");
      this.timeout(job, remaining);
      const input = buildTitleInput(projectBranch(ctx.sessionManager.getBranch()), command, before.title, config.maxInputChars);
      const rules = await abortable(this.deps.loadRules(config), job.controller.signal);
      this.fresh(job);
      const raw = await abortable(this.deps.generate({ model: ctx.model, modelRegistry: ctx.modelRegistry, sessionId: before.sessionId }, config, input, rules, job.controller.signal), job.controller.signal);
      this.fresh(job);
      const title = validateTitle(raw);
      if (!title || title === before.title) {
        ctx.ui.notify(title ? "The title is unchanged." : "No clear task identified; keeping the previous title.", "info");
        return;
      }
      if (job.timer) clearTimeout(job.timer);
      await this.apply(job, title, before.title);
      if (this.owns(job)) ctx.ui.notify(`Title updated${input.truncated ? " (history trimmed to budget)" : ""}: ${title}`, "info");
    } catch (error) {
      if (this.active === job && this.epoch === job.epoch) {
        ctx.ui.notify(error instanceof RetitleError ? error.message : "Title refresh failed. Check the model, authentication, and configuration. Raw error details are hidden to protect sensitive data.", "error");
      }
    } finally {
      this.finish(job);
    }
  }

  private async apply(job: Job, title: string, previousTitle: string | null): Promise<void> {
    this.fresh(job);
    const ctx = job.ctx;
    const oldHistory = history(ctx);
    this.committing = true;
    let writing: Snapshot | undefined;
    try {
      // No await between the final freshness check and entering OMP's setter.
      // 18.1.16 updates memory synchronously, then awaits persistence.
      const write = this.api.setSessionName(title);
      writing = snapshot(ctx);
      await write;
      if (!this.owns(job) || !same(snapshot(ctx), writing) || writing.title !== title) {
        throw new RetitleError("The session or title changed while saving; no new undo record was written. Check the original session title.");
      }
      const state: UndoState = { version: 1, sessionId: job.before.sessionId, previousTitle, appliedTitle: title, titleVersion: writing.titleVersion };
      this.api.appendEntry(JOURNAL_TYPE, state);
    } catch (error) {
      let restored = false;
      // Never compensate into another branch, after an external rename, or
      // after lifecycle invalidation. Cross-process atomic CAS is unavailable.
      if (writing && this.owns(job) && same(snapshot(ctx), writing) && writing.title === title) {
        try {
          const rollback = this.api.setSessionName(job.before.title!);
          const reverting = snapshot(ctx);
          await rollback;
          restored = this.owns(job) && same(snapshot(ctx), reverting) && reverting.title === job.before.title;
          if (restored && oldHistory && oldHistory.appliedTitle === job.before.title && oldHistory.titleVersion === job.before.titleVersion) {
            // Preserve the prior successful undo even when a failed write added
            // title audit entries. Only rebase its guard; do not change its value.
            this.api.appendEntry(JOURNAL_TYPE, { ...oldHistory, titleVersion: reverting.titleVersion });
          }
        } catch { /* Persistence may be unavailable: do not promise a rollback. */ }
      }
      if (error instanceof RetitleError && !restored) throw error;
      throw new RetitleError(restored ? "Saving failed; the previous title was restored." : "Saving failed and rollback could not be confirmed. Check the session title and storage.");
    } finally {
      this.committing = false;
    }
  }
}
