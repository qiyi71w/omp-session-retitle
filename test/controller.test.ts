import { expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { JOURNAL_TYPE, RetitleController, type RetitleContext, type RetitleDependencies } from "../src/controller.ts";
import { parseConfig } from "../src/config.ts";

function user(id: string, content: string): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-09-11T00:00:00Z", message: { role: "user", content, timestamp: 0 } };
}

function harness() {
  let title = "[-][chore][wayfinder] 共享会话任务规划";
  let leaf = "u1";
  let sessionId = "session-a";
  let count = 0;
  const entries: SessionEntry[] = [user("u1", "在项目中实现 OMP 会话手动重命名扩展")];
  const notices: string[] = [];
  let calls = 0;
  const ctx: RetitleContext = {
    cwd: "/project", mode: "rpc", model: undefined,
    modelRegistry: { find: () => undefined, getApiKey: async () => "test-only-key", getProviderHeaders: () => undefined },
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: message => { notices.push(message); }, setStatus: () => {}, onTerminalInput: () => () => {} },
    sessionManager: {
      getSessionId: () => sessionId, getSessionFile: () => `/session/${sessionId}.jsonl`, getCwd: () => ctx.cwd,
      getSessionName: () => title, getLeafId: () => leaf,
      getEntries: () => [...entries], getBranch: () => [...entries],
    },
  };
  const api = {
    async setSessionName(name: string) {
      entries.push({ type: "title_change", id: `title-${++count}`, parentId: leaf, timestamp: "2026-09-11T00:00:00Z", title: name, previousTitle: title, source: "user" });
      title = name;
    },
    appendEntry(customType: string, data?: unknown) {
      const id = `custom-${++count}`;
      entries.push({ type: "custom", id, parentId: leaf, timestamp: "2026-09-11T00:00:00Z", customType, data });
      leaf = id;
    },
  };
  const deps: RetitleDependencies = {
    loadConfig: async () => parseConfig({}),
    loadRules: async () => "rules",
    generate: async () => { calls++; return "[-][enhancement][implement] OMP 会话手动重命名"; },
  };
  const controller = new RetitleController(api, deps);
  return { controller, ctx, entries, notices, deps, api, title: () => title, calls: () => calls,
    switchTo: (id: string) => { sessionId = id; },
    addUser: (id: string, text: string) => { entries.push(user(id, text)); leaf = id; },
  };
}

test("retitle changes metadata; one-step undo survives a new controller and never calls the model", async () => {
  const h = harness();
  const before = h.title();
  await h.controller.handle("", h.ctx);
  expect(h.title()).toBe("[-][enhancement][implement] OMP 会话手动重命名");
  expect(h.calls()).toBe(1);
  expect(h.entries.filter(entry => entry.type === "message")).toHaveLength(1);
  await new RetitleController(h.api, h.deps).handle("undo", h.ctx);
  expect(h.title()).toBe(before);
  expect(h.calls()).toBe(1);
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe(before);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function generating(h: ReturnType<typeof harness>) {
  const started = deferred<AbortSignal>();
  const answer = deferred<string>();
  h.deps.generate = async (_ctx, _config, _input, _rules, signal) => { started.resolve(signal); return answer.promise; };
  const running = h.controller.handle("", h.ctx);
  const signal = await started.promise;
  return { answer, running, signal };
}

for (const response of ["<title>broken", "[-][chore][implement] 第一行\n第二行"]) {
  test(`invalid response preserves title and the prior undo: ${JSON.stringify(response)}`, async () => {
    const h = harness();
    const original = h.title();
    await h.controller.handle("", h.ctx);
    const valid = h.title();
    h.deps.generate = async () => response;
    await h.controller.handle("", h.ctx);
    expect(h.title()).toBe(valid);
    await h.controller.handle("undo", h.ctx);
    expect(h.title()).toBe(original);
  });
}

for (const response of ["none", "[-][chore][wayfinder] 共享会话任务规划"]) {
  test(`no-op response does not create an undo: ${response}`, async () => {
    const h = harness();
    h.deps.generate = async () => response;
    await h.controller.handle("", h.ctx);
    expect(h.entries.filter(entry => entry.type === "custom")).toHaveLength(0);
  });
}

test("cancel settles immediately even when the provider ignores its signal", async () => {
  const h = harness();
  const before = h.title();
  const pending = await generating(h);
  await h.controller.handle("cancel", h.ctx);
  await pending.running;
  expect(pending.signal.aborted).toBe(true);
  pending.answer.resolve("[-][bug][implement] 不应覆盖");
  await Promise.resolve();
  expect(h.title()).toBe(before);
});

test("latest request wins; a stale completion cannot clear or overwrite the winner", async () => {
  const h = harness();
  const old = await generating(h);
  h.deps.generate = async () => "[-][enhancement][implement] 最新主任务";
  await h.controller.handle("主任务纠偏", h.ctx);
  old.answer.resolve("[-][chore][implement] 旧结果");
  await old.running;
  expect(old.signal.aborted).toBe(true);
  expect(h.title()).toBe("[-][enhancement][implement] 最新主任务");
});

for (const change of ["switch", "away-and-back", "branch", "cwd", "new-message", "external-rename", "rename-away-and-back", "busy", "queued"]) {
  test(`in-flight state change drops the result: ${change}`, async () => {
    const h = harness();
    const before = h.title();
    const pending = await generating(h);
    if (change === "switch") { h.controller.invalidate(); h.switchTo("session-b"); }
    if (change === "away-and-back") { h.controller.invalidate(); h.switchTo("session-b"); h.switchTo("session-a"); }
    if (change === "branch") h.controller.invalidate();
    if (change === "cwd") h.ctx.cwd = "/other";
    if (change === "new-message") h.addUser("u2", "继续修 CI");
    if (change === "external-rename" || change === "rename-away-and-back") await h.api.setSessionName("外部标题");
    if (change === "rename-away-and-back") await h.api.setSessionName(before);
    if (change === "busy") h.ctx.isIdle = () => false;
    if (change === "queued") h.ctx.hasPendingMessages = () => true;
    pending.answer.resolve("[-][chore][implement] 不应采用");
    await pending.running;
    expect(h.title()).toBe(change === "external-rename" ? "外部标题" : before);
    expect(h.entries.filter(entry => entry.type === "custom")).toHaveLength(0);
  });
}

test("undo cancels generation before restoring, and cannot cross a fork", async () => {
  const h = harness();
  const before = h.title();
  await h.controller.handle("", h.ctx);
  const pending = await generating(h);
  await h.controller.handle("undo", h.ctx);
  pending.answer.resolve("[-][bug][implement] 迟到标题");
  await pending.running;
  expect(h.title()).toBe(before);
  h.deps.generate = async () => "[-][enhancement][implement] 新标题";
  await h.controller.handle("", h.ctx);
  h.switchTo("fork");
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe("[-][enhancement][implement] 新标题");
});

test("manual rename invalidates undo, including an identical final title", async () => {
  const h = harness();
  await h.controller.handle("", h.ctx);
  const generated = h.title();
  await h.api.setSessionName("用户改名");
  await h.api.setSessionName(generated);
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe(generated);
});

test("a malformed newest journal cannot resurrect an older undo", async () => {
  const h = harness();
  await h.controller.handle("", h.ctx);
  const generated = h.title();
  h.api.appendEntry(JOURNAL_TYPE, { sessionId: "session-a", version: 9 });
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe(generated);
});

test("a journal with a missing session identity blocks stale undo instead of being treated as a foreign fork", async () => {
  const h = harness();
  await h.controller.handle("", h.ctx);
  const generated = h.title();
  h.api.appendEntry(JOURNAL_TYPE, {});
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe(generated);
});

test("configuration and transport failures do not leak provider errors or change metadata", async () => {
  const h = harness();
  const before = h.title();
  h.deps.generate = async () => { throw new Error("Authorization: secret-test-only"); };
  await h.controller.handle("", h.ctx);
  expect(h.title()).toBe(before);
  expect(h.notices.join(" ")).not.toContain("secret-test-only");
  h.deps.loadConfig = async () => { throw new Error("bad config"); };
  await h.controller.handle("", h.ctx);
  expect(h.entries.filter(entry => entry.type === "custom")).toHaveLength(0);
});

test("timeout aborts and discards a late answer", async () => {
  const h = harness();
  h.deps.loadConfig = async () => parseConfig({ timeoutMs: 1000 });
  const before = h.title();
  const pending = await generating(h);
  await pending.running;
  expect(pending.signal.aborted).toBe(true);
  pending.answer.resolve("[-][chore][implement] 迟到结果");
  await Promise.resolve();
  expect(h.title()).toBe(before);
});

test("busy/queued/unnamed sessions never call a model", async () => {
  for (const condition of ["busy", "queued", "unnamed"]) {
    const h = harness();
    if (condition === "busy") h.ctx.isIdle = () => false;
    if (condition === "queued") h.ctx.hasPendingMessages = () => true;
    if (condition === "unnamed") h.ctx.sessionManager.getSessionName = () => undefined;
    await h.controller.handle("", h.ctx);
    expect(h.calls()).toBe(0);
  }
});

test("Esc cancels the auxiliary request, with listener cleanup", async () => {
  const h = harness();
  h.ctx.mode = "tui";
  let listener: ((data: string) => unknown) | undefined;
  h.ctx.ui.onTerminalInput = callback => { listener = callback; return () => { listener = undefined; }; };
  const before = h.title();
  const pending = await generating(h);
  expect(listener?.("\u001b")).toEqual({ consume: true });
  await pending.running;
  expect(listener).toBeUndefined();
  expect(pending.signal.aborted).toBe(true);
  expect(h.title()).toBe(before);
  pending.answer.resolve("none");
});

test("write-phase concurrency is refused; a disk failure rolls back without losing the prior undo", async () => {
  const h = harness();
  const original = h.title();
  await h.controller.handle("", h.ctx);
  const before = h.title();
  const write = h.api.setSessionName;
  let failing = true;
  h.api.setSessionName = async title => {
    await write(title);
    if (failing) { failing = false; throw new Error("disk failed after memory update"); }
  };
  h.deps.generate = async () => "[-][bug][implement] 不应保留";
  await h.controller.handle("", h.ctx);
  expect(h.title()).toBe(before);
  await h.controller.handle("undo", h.ctx);
  expect(h.title()).toBe(original);
});

test("another command cannot overtake an in-flight persistence operation", async () => {
  const h = harness();
  const writing = deferred<void>();
  const started = deferred<void>();
  const write = h.api.setSessionName;
  h.api.setSessionName = async title => { const result = write(title); started.resolve(); await writing.promise; await result; };
  const running = h.controller.handle("", h.ctx);
  await started.promise;
  await h.controller.handle("undo", h.ctx);
  await h.controller.handle("cancel", h.ctx);
  expect(h.calls()).toBe(1);
  writing.resolve();
  await running;
  expect(h.title()).toBe("[-][enhancement][implement] OMP 会话手动重命名");
});

test("switch during persistence does not append undo into the new session", async () => {
  const h = harness();
  const writing = deferred<void>();
  const started = deferred<void>();
  const write = h.api.setSessionName;
  h.api.setSessionName = async title => { const result = write(title); started.resolve(); await writing.promise; await result; };
  const running = h.controller.handle("", h.ctx);
  await started.promise;
  h.controller.invalidate();
  h.switchTo("session-b");
  writing.resolve();
  await running;
  expect(h.entries.filter(entry => entry.type === "custom")).toHaveLength(0);
});
