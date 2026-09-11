import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

interface RpcReply {
  type?: string;
  id?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// Opt-in: never assumes every contributor has an OMP executable installed.
test.skipIf(process.env.OMP_RETITLE_SMOKE !== "1")("native OMP binary loads extension, renames, and undoes without a main-agent message or a real model", async () => {
  const binary = process.env.OMP_BINARY;
  if (!binary) throw new Error("Set OMP_BINARY to the OMP 18.1.16 executable.");
  const root = await mkdtemp(join(tmpdir(), "retitle-runtime-test-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(agentDir)]);
  const child = spawn(binary, [
    "--mode", "rpc", "--no-session", "--no-title", "--no-tools", "--no-lsp", "--no-pty",
    "--no-extensions", "--no-skills", "--no-rules", "--thinking", "high",
    "-e", fileURLToPath(new URL("./fixtures/mock-provider.ts", import.meta.url)),
    "-e", fileURLToPath(new URL("../index.ts", import.meta.url)),
    "--model", "retitle-test/title-model",
  ], {
    cwd,
    // Deliberately omit auth variables, proxy variables, named profiles, and
    // inherited user config. No user credential directory is mounted here.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TERM: "dumb", NO_COLOR: "1",
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const events: RpcReply[] = [];
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const pending = new Map<string, { resolve: (reply: RpcReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let event: RpcReply;
    try { event = JSON.parse(line); } catch { return; }
    if (events.length < 100) events.push(event);
    if (event.type !== "response" || !event.id) return;
    const waiting = pending.get(event.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(event.id);
    if (event.success === false) waiting.reject(new Error(`RPC ${event.id}: ${event.error}`));
    else waiting.resolve(event);
  });
  function failPending(error: Error) {
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    pending.clear();
  }
  child.on("error", failPending);
  child.on("exit", (code, signal) => {
    failPending(new Error(`OMP exited (${code ?? signal}); ${stderr.slice(-6000)}`));
  });
  let serial = 0;
  function rpc(type: string, fields: Record<string, unknown> = {}): Promise<RpcReply> {
    const id = `${++serial}-${type}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout ${id}; stderr=${stderr.slice(-6000)}; events=${JSON.stringify(events).slice(-6000)}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }
  async function stateWithTitle(title: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 40; i++) {
      const state = (await rpc("get_state")).data ?? {};
      if (state.sessionName === title) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Title not updated: ${title}; stderr=${stderr.slice(-6000)}; events=${JSON.stringify(events).slice(-6000)}`);
  }
  try {
    const commands = await rpc("get_available_commands");
    if (!JSON.stringify(commands.data).includes('"name":"retitle"')) {
      throw new Error(`Extension did not load; stderr=${stderr}`);
    }
    expect(JSON.stringify(commands.data)).toContain("retitle");
    await rpc("set_session_name", { name: "[-][chore][wayfinder] 共享会话任务规划" });
    const before = (await rpc("get_state")).data!;
    expect(before.model).toMatchObject({ provider: "retitle-test", id: "title-model" });
    expect(before.thinkingLevel).toBe("high");
    expect((await rpc("get_messages")).data?.messages).toEqual([]);
    await rpc("prompt", { message: "/retitle 实现 OMP 会话手动重命名扩展，后面的 CI 不作为主题" });
    const after = await stateWithTitle("Refresh session titles");
    expect(after.model).toEqual(before.model);
    expect(after.thinkingLevel).toBe(before.thinkingLevel);
    expect((await rpc("get_messages")).data?.messages).toEqual([]);
    await rpc("prompt", { message: "/retitle undo" });
    await stateWithTitle("[-][chore][wayfinder] 共享会话任务规划");
    expect((await rpc("get_messages")).data?.messages).toEqual([]);
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "TITLE_SYSTEM.md"), "PROJECT POLICY: Use the project's naming style.");
    await rpc("prompt", { message: "/retitle Refresh the session title" });
    await stateWithTitle("Project policy title");
    await rpc("prompt", { message: "/retitle undo" });
    await stateWithTitle("[-][chore][wayfinder] 共享会话任务规划");
    expect((await rpc("get_messages")).data?.messages).toEqual([]);
    expect(stderr.split("RETITLE_OFFLINE_MOCK_CALL").length - 1).toBe(2);
  } finally {
    for (const waiting of pending.values()) clearTimeout(waiting.timer);
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
