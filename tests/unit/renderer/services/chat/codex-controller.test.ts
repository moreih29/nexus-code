import { describe, expect, test } from "bun:test";
import {
  answerOf,
  isSupportedCodex,
  suggestedPaths,
} from "../../../../../src/renderer/services/chat/codex-controller";

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
