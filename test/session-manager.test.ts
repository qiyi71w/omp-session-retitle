import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { RetitleController, type RetitleContext, type RetitleDependencies } from "../src/controller.ts";
import { parseConfig } from "../src/config.ts";
import { projectBranch } from "../src/omp.ts";
import { buildTitleInput } from "../src/title-policy.ts";

function setup(manager: SessionManager) {
  const notices: string[] = [];
  let calls = 0;
  const ctx: RetitleContext = {
    cwd: manager.getCwd(), mode: "rpc", model: undefined, sessionManager: manager,
    modelRegistry: { find: () => undefined, getApiKey: async () => undefined, getProviderHeaders: () => undefined },
    ui: { notify: text => { notices.push(text); }, setStatus: () => {}, onTerminalInput: () => () => {} },
    isIdle: () => true, hasPendingMessages: () => false,
  };
  const api = {
    setSessionName: async (name: string) => { await manager.setSessionName(name, "user"); },
    appendEntry: (kind: string, data?: unknown) => { manager.appendCustomEntry(kind, data); },
  };
  const deps: RetitleDependencies = {
    loadConfig: async () => parseConfig({}), loadRules: async () => "rules",
    generate: async () => { calls++; return "[T#08][enhancement][implement] 应用设置"; },
  };
  return { ctx, api, deps, notices, controller: new RetitleController(api, deps), calls: () => calls };
}

test("real OMP SessionManager: sibling task is absent from title input", () => {
  const manager = SessionManager.inMemory("/retitle-test");
  const root = manager.appendMessage({ role: "user", content: "开始任务", timestamp: 0 });
  manager.appendMessage({ role: "user", content: "兄弟分支处理 I#999", timestamp: 1 });
  manager.branch(root);
  manager.appendMessage({ role: "user", content: "实现 issues/08-app-settings.md", timestamp: 2 });
  const input = buildTitleInput(projectBranch(manager.getBranch()), "", "old", 4000);
  expect(input.text).not.toContain("I#999");
});

test("real OMP SessionManager: title writes do not enter model messages, and branch metadata supports undo", async () => {
  const manager = SessionManager.inMemory("/retitle-test");
  manager.appendMessage({ role: "user", content: "实现 issues/08-app-settings.md", timestamp: 0 });
  await manager.setSessionName("旧标题", "user");
  const before = manager.buildSessionContext().messages;
  const h = setup(manager);
  await h.controller.handle("", h.ctx);
  expect(manager.getSessionName()).toBe("[T#08][enhancement][implement] 应用设置");
  expect(manager.buildSessionContext().messages).toEqual(before);
  await new RetitleController(h.api, h.deps).handle("undo", h.ctx);
  expect(manager.getSessionName()).toBe("旧标题");
  expect(manager.buildSessionContext().messages).toEqual(before);
  expect(h.calls()).toBe(1);
  expect(await manager.setSessionName("自动生成应被忽略", "auto")).toBe(false);
  expect(manager.getSessionName()).toBe("旧标题");
});

test("real OMP SessionManager: navigating before the journal cannot undo another branch's rename", async () => {
  const manager = SessionManager.inMemory("/retitle-test");
  const root = manager.appendMessage({ role: "user", content: "实现 issues/08-app-settings.md", timestamp: 0 });
  await manager.setSessionName("旧标题", "user");
  const h = setup(manager);
  await h.controller.handle("", h.ctx);
  manager.branch(root);
  manager.appendMessage({ role: "user", content: "另一个分支任务", timestamp: 1 });
  await h.controller.handle("undo", h.ctx);
  expect(manager.getSessionName()).toBe("[T#08][enhancement][implement] 应用设置");
});
