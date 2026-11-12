import { describe, expect, test } from "bun:test";
import {
  answerOf,
  isSupportedCodex,
  picksOf,
  suggestedPaths,
  threadSettings,
  threadStartParams,
  threadsOf,
} from "../../../../../src/renderer/services/chat/codex-controller";
import { emptyCodexModel } from "../../../../../src/renderer/services/chat/codex-model";

describe("codex answers", () => {
  test("an approval's decision from the card's answer", () => {
    const method = "item/commandExecution/requestApproval";
    expect(answerOf(method, {}, { kind: "allow" })).toEqual({ decision: "accept" });
    expect(answerOf(method, {}, { kind: "allow-always" })).toEqual({
      decision: "acceptForSession",
    });
    expect(answerOf(method, {}, { kind: "deny", message: "no" })).toEqual({ decision: "decline" });
    expect(answerOf("item/fileChange/requestApproval", {}, { kind: "deny-stop" })).toEqual({
      decision: "cancel",
    });
  });

  test("more access, for the turn or the session, or none", () => {
    const method = "item/permissions/requestApproval";
    const permissions = { network: { enabled: true }, fileSystem: null };
    expect(answerOf(method, { permissions }, { kind: "allow" })).toEqual({
      permissions,
      scope: "turn",
    });
    expect(answerOf(method, { permissions }, { kind: "allow-always" })).toEqual({
      permissions,
      scope: "session",
    });
    expect(answerOf(method, { permissions }, { kind: "deny" })).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  test("a question's answers go by the question's id", () => {
    const method = "item/tool/requestUserInput";
    const params = { questions: [{ id: "color", question: "Which color?" }] };
    expect(
      answerOf(method, params, {
        kind: "allow",
        updatedInput: { answers: { "Which color?": "Red" } },
      }),
    ).toEqual({ answers: { color: { answers: ["Red"] } } });
    expect(answerOf(method, params, { kind: "deny" })).toEqual({ answers: {} });
  });

  test("the version gate", () => {
    expect(isSupportedCodex("0.166.0")).toBe(true);
    expect(isSupportedCodex("0.170.1")).toBe(true);
    expect(isSupportedCodex("0.120.0")).toBe(false);
    expect(isSupportedCodex(null)).toBe(true);
  });
});

describe("codex @-mention suggestions", () => {
  test("leave out git's own folder, by either separator", () => {
    const files = [
      ".git\\HEAD",
      ".git/config",
      "sub\\.git\\index",
      "sub/.git",
      ".github\\workflows\\ci.yml",
      ".gitignore",
      "src\\math.ts",
      "my.git\\a.ts",
    ].map((path) => ({ root: "C:\\w", path, score: 1 }));
    expect(suggestedPaths(files)).toEqual([
      ".github\\workflows\\ci.yml",
      ".gitignore",
      "src\\math.ts",
      "my.git\\a.ts",
    ]);
  });

  test("keep as many as the menu shows once git's are out", () => {
    const files = [
      ...Array.from({ length: 10 }, (_, i) => ({ path: `.git/objects/${i}` })),
      ...Array.from({ length: 60 }, (_, i) => ({ path: `src/${i}.ts` })),
    ];
    const paths = suggestedPaths(files);
    expect(paths).toHaveLength(50);
    expect(paths[0]).toBe("src/0.ts");
  });

  test("nothing from a reply that is not a list of paths", () => {
    expect(suggestedPaths(undefined)).toEqual([]);
    expect(suggestedPaths([null, { path: 3 }, { path: "" }, { path: "a.ts" }])).toEqual(["a.ts"]);
  });
});

describe("codex thread settings", () => {
  const target = { workspaceId: "w", tabId: "t", cwd: "/home/u/.nexus-code/manager" };

  test("a tab's thread is told nothing more", () => {
    expect(threadSettings(target)).toEqual({});
  });

  test("the manager's thread gets its instructions, and its folder trusted for it alone", () => {
    expect(threadSettings({ ...target, developerInstructions: "Manage.", trusted: true })).toEqual({
      developerInstructions: "Manage.",
      config: { projects: { "/home/u/.nexus-code/manager": { trust_level: "trusted" } } },
    });
  });

  test("a new thread starts with the tab's picks, its effort as a config override", () => {
    expect(threadStartParams(target, {})).toEqual({ cwd: target.cwd });
    expect(
      threadStartParams(
        { ...target, trusted: true },
        { model: "gpt-x", effort: "low", mode: "readOnly" },
      ),
    ).toEqual({
      cwd: target.cwd,
      config: {
        projects: { "/home/u/.nexus-code/manager": { trust_level: "trusted" } },
        model_reasoning_effort: "low",
      },
      model: "gpt-x",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });

  test("/new's thread goes on with what the last one ran with", () => {
    const model = {
      ...emptyCodexModel(),
      model: "gpt-x",
      effort: "high",
      permissionMode: "fullAccess",
    };
    expect(picksOf(model)).toEqual({ model: "gpt-x", effort: "high", mode: "fullAccess" });
    expect(picksOf({ ...emptyCodexModel(), permissionMode: "default" })).toEqual({});
  });
});

describe("codex threads to go on with", () => {
  test("named by their name, else their first prompt's first line; seconds become ms", () => {
    const listed = threadsOf([
      {
        id: "t1",
        name: null,
        preview: "Fix the build\nand the tests",
        updatedAt: 1_700_000_000,
        gitInfo: { branch: "main" },
      },
      { id: "t2", name: "Named", preview: "first prompt", updatedAt: 1_700_000_100, gitInfo: null },
    ]);
    expect(listed).toEqual([
      {
        sessionId: "t1",
        title: "Fix the build",
        firstPrompt: "Fix the build\nand the tests",
        gitBranch: "main",
        lastModified: 1_700_000_000_000,
      },
      {
        sessionId: "t2",
        title: "Named",
        firstPrompt: "first prompt",
        lastModified: 1_700_000_100_000,
      },
    ]);
  });

  test("a thread's file is kept, for its size and nothing else", () => {
    const [listed] = threadsOf([
      {
        id: "t1",
        preview: "Fix it",
        updatedAt: 1,
        path: "/home/me/.codex/sessions/rollout-t1.jsonl",
      },
    ]);
    expect(listed?.path).toBe("/home/me/.codex/sessions/rollout-t1.jsonl");
    expect(threadsOf([{ id: "t2", preview: "x", path: "  " }])[0]).not.toHaveProperty("path");
  });

  test("a thread with nothing to call it by, or no id, is left out", () => {
    expect(threadsOf([{ id: "t1", preview: "  " }, { preview: "no id" }, null])).toEqual([]);
    expect(threadsOf(undefined)).toEqual([]);
  });
});
