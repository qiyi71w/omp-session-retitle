import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadRules, parseConfig } from "../src/config.ts";

test("configuration rejects unknown keys and incomplete model overrides", () => {
  expect(() => parseConfig({ resonning: "high" })).toThrow();
  expect(() => parseConfig({ model: { provider: "openai" } })).toThrow();
});

for (const value of [
  null, [], "json", { model: "tiny" }, { model: { provider: "p", id: "m", apiKey: "not-allowed" } },
  { reasoning: "auto" }, { reasoning: null }, { timeoutMs: -1 }, { timeoutMs: "1000" },
  { maxInputChars: 100 }, { maxInputChars: Infinity }, { maxOutputTokens: 64 },
  { titleSystemPath: "" }, { manualRefreshPath: "" }, { manualRefreshPath: false }, { model: { provider: " p ", id: "m" } },
]) {
  test(`invalid configuration fails closed: ${JSON.stringify(value)}`, () => {
    expect(() => parseConfig(value)).toThrow();
  });
}

async function fixture(run: (agent: string, project: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "retitle-config-test-"));
  const agent = join(root, "agent");
  const project = join(root, "project");
  await mkdir(agent);
  await mkdir(join(project, ".omp"), { recursive: true });
  try { await run(agent, project, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("configuration precedence is defaults < global < project < explicit; model is atomic", async () => {
  await fixture(async (agent, project, root) => {
    await writeFile(join(agent, "retitle.json"), JSON.stringify({ model: { provider: "p", id: "m" }, reasoning: "low", timeoutMs: 20000 }));
    await writeFile(join(project, ".omp", "retitle.json"), JSON.stringify({ reasoning: "medium", maxOutputTokens: 4096 }));
    const explicit = join(root, "explicit.json");
    await writeFile(explicit, JSON.stringify({ model: null, timeoutMs: 5000 }));
    expect(await loadConfig(project, agent, explicit)).toMatchObject({ model: null, reasoning: "medium", timeoutMs: 5000, maxOutputTokens: 4096 });
    await writeFile(explicit, JSON.stringify({ model: { id: "incomplete" } }));
    await expect(loadConfig(project, agent, explicit)).rejects.toThrow();
  });
});

test("relative base and manual rules resolve from their declaring config layers", async () => {
  await fixture(async (agent, project) => {
    await writeFile(join(agent, "base.md"), "CUSTOM BASE RULES");
    await writeFile(join(project, ".omp", "manual.md"), "CUSTOM MANUAL RULES");
    await writeFile(join(agent, "retitle.json"), JSON.stringify({ titleSystemPath: "base.md" }));
    await writeFile(join(project, ".omp", "retitle.json"), JSON.stringify({ reasoning: "low", manualRefreshPath: "manual.md" }));
    const config = await loadConfig(project, agent);
    expect(config.titleSystemPath).toBe(join(agent, "base.md"));
    const rules = await loadRules(config);
    expect(rules).toStartWith("CUSTOM BASE RULES");
    expect(rules).toContain("CUSTOM MANUAL RULES");
  });
});

test("optional files may be absent, but malformed and explicit-missing files do not disappear", async () => {
  await fixture(async (agent, project, root) => {
    expect((await loadConfig(project, agent)).reasoning).toBe("off");
    await expect(loadConfig(project, agent, join(root, "missing.json"))).rejects.toThrow();
    await writeFile(join(agent, "retitle.json"), "{broken");
    await expect(loadConfig(project, agent)).rejects.toThrow();
    await writeFile(join(agent, "retitle.json"), " ".repeat(32769));
    await expect(loadConfig(project, agent)).rejects.toThrow();
  });
});

test("missing, empty, oversized, and non-file rule paths fail before generation", async () => {
  await fixture(async (_agent, _project, root) => {
    const path = join(root, "rules.md");
    await expect(loadRules(parseConfig({ titleSystemPath: path }))).rejects.toThrow();
    await writeFile(path, " ");
    await expect(loadRules(parseConfig({ titleSystemPath: path }))).rejects.toThrow();
    await writeFile(path, "x".repeat(65537));
    await expect(loadRules(parseConfig({ titleSystemPath: path }))).rejects.toThrow();
    await expect(loadRules(parseConfig({ titleSystemPath: root }))).rejects.toThrow();
  });
});

test("native project rules are reused, with explicit bundled selection and null reset", async () => {
  await fixture(async (agent, project) => {
    const native = join(project, ".omp", "TITLE_SYSTEM.md");
    await writeFile(native, "PROJECT TITLE POLICY");
    expect((await loadRules(await loadConfig(project, agent))).startsWith("PROJECT TITLE POLICY")).toBe(true);
    await writeFile(join(agent, "retitle.json"), JSON.stringify({ titleSystemPath: "bundled" }));
    const bundled = await loadRules(await loadConfig(project, agent));
    expect(bundled).toStartWith("# Session title");
    await writeFile(join(project, ".omp", "retitle.json"), JSON.stringify({ titleSystemPath: null }));
    expect((await loadConfig(project, agent)).titleSystemPath).toBe(native);
    await writeFile(native, " ");
    await expect(loadRules(await loadConfig(project, agent))).rejects.toThrow();
  });
});

test("manual policy can be disabled, but an explicit missing or empty file fails", async () => {
  await fixture(async (_agent, _project, root) => {
    const base = join(root, "base.md");
    const manual = join(root, "manual.md");
    await writeFile(base, "BASE");
    const without = await loadRules(parseConfig({ titleSystemPath: base, manualRefreshPath: null }));
    expect(without).not.toContain("# Manual refresh");
    expect(without).toStartWith("BASE");
    await expect(loadRules(parseConfig({ titleSystemPath: base, manualRefreshPath: manual }))).rejects.toThrow();
    await writeFile(manual, " ");
    await expect(loadRules(parseConfig({ titleSystemPath: base, manualRefreshPath: manual }))).rejects.toThrow();
  });
});

test("absent OMP files use bundled rules; project policy takes precedence over agent policy", async () => {
  await fixture(async (agent, project) => {
    expect(await loadRules(await loadConfig(project, agent))).toStartWith("# Session title");
    await writeFile(join(agent, "TITLE_SYSTEM.md"), "AGENT POLICY");
    expect(await loadRules(await loadConfig(project, agent))).toStartWith("AGENT POLICY");
    await writeFile(join(project, ".omp", "TITLE_SYSTEM.md"), "PROJECT POLICY");
    expect(await loadRules(await loadConfig(project, agent))).toStartWith("PROJECT POLICY");
  });
});
