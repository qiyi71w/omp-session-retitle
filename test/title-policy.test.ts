import { describe, expect, test } from "bun:test";
import { buildTitleInput, validateTitle } from "../src/title-policy.ts";

describe("title policy", () => {
  for (const title of [
    "", "```title```", "<title>broken", "<title>one</title><title>two</title>",
    "[-][bug][implement] 第一行\n第二行", "[-][bug][implement] 控制\u001b字符",
    "[-][bug][implement] 隐藏\u200b字符", "[-][bug][implement] 双向\u202e字符",
    "[-][bug][implement] 分行\u2028字符", "[-][bug][implement] " + "长".repeat(80),
  ]) {
    test(`invalid format is rejected: ${JSON.stringify(title)}`, () => {
      expect(() => validateTitle(title)).toThrow();
    });
  }

  test("boundary length counts Unicode code points, not UTF-16 halves", () => {
    const title = "[-][bug][implement] " + "🧪".repeat(60);
    expect([...title]).toHaveLength(80);
    expect(validateTitle(title)).toBe(title);
    expect(() => validateTitle(title + "字")).toThrow();
    expect(validateTitle(" none\n")).toBeNull();
  });

  test("native wrappers and arbitrary naming styles preserve the user's title", () => {
    for (const title of ["Fix login on mobile", "修复登录", "[feature][plan] Login", "PROJ-42: Login", "[T#42] Fix login"]) {
      expect(validateTitle(title)).toBe(title);
      expect(validateTitle(`<title>${title}</title>`)).toBe(title);
    }
    expect(validateTitle("<title/>")).toBeNull();
    expect(validateTitle("<title></title>")).toBeNull();
  });

  test("input retains the early task, later correction, and follow-up CI as labeled data", () => {
    const input = buildTitleInput([
      { id: "u1", role: "user", text: "分析并规划共享会话" },
      { id: "u2", role: "user", text: "在项目实现 OMP 会话手动重命名扩展" },
      { id: "u3", role: "user", text: "修 CI、测试并开 PR" },
    ], "主题是手动重命名，不是开 PR", "old", 4000);
    const data = JSON.parse(input.text);
    expect(data.transcript.map((item: { text: string }) => item.text)).toEqual([
      "分析并规划共享会话", "在项目实现 OMP 会话手动重命名扩展", "修 CI、测试并开 PR",
    ]);
    expect(data.manualHint).toContain("不是开 PR");
    expect(input.truncated).toBe(false);
  });

  test("serialized input remains bounded even with escaped control characters", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: String(index), role: "user" as const, text: `${index}目标\u0000\"\\`.repeat(2000) }));
    const input = buildTitleInput(items, "明确主任务", "old", 4000);
    expect(input.text.length).toBeLessThanOrEqual(4000);
    expect(input.truncated).toBe(true);
    const data = JSON.parse(input.text);
    expect(data.transcript[0].id).toBe("0");
    expect(data.transcript.at(-1).id).toBe("99");
  });

  test("empty history and oversized hints fail locally", () => {
    expect(() => buildTitleInput([], "", "old", 4000)).toThrow();
    expect(() => buildTitleInput([], "x".repeat(2001), "old", 4000)).toThrow();
    expect(() => buildTitleInput([], "task", "old", 100)).toThrow();
  });
});
