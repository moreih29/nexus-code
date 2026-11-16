import { describe, expect, test } from "bun:test";
import {
  ConfigRefusal,
  chatConfigOf,
  configSetOf,
  configShownOf,
} from "../../../../../src/renderer/services/remote/chat-config";

const listed = [
  { key: "model", kind: "choice" as const, options: ["default", "sonnet", "opus"] },
  { key: "verbose", kind: "boolean" as const },
  { key: "language", kind: "text" as const },
  {
    key: "permissionMode",
    kind: "choice" as const,
    options: ["default", "plan", "acceptEdits", "bypassPermissions"],
  },
  { key: "newKey", kind: "boolean" as const },
];

const models = [
  {
    value: "sonnet",
    displayName: "Sonnet",
    resolvedModel: "claude-sonnet-5-5",
    supportedEffortLevels: ["low", "high", "max"],
  },
  { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "xhigh"] },
];

function told(effort = true) {
  return chatConfigOf({
    effective: {
      model: "opus",
      verbose: true,
      effortLevel: "low",
      modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, junk: null },
      env: { SECRET: "x" },
    },
    global: { verbose: false },
    model: "claude-opus-5-5",
    listed,
    models,
    outputStyles: ["default", "Mine"],
    effort,
  });
}

describe("a chat's settings told to another device", () => {
  test("each key the dialog shows, in its group, with what it takes and is now", () => {
    const config = told();
    expect(config.keys.map((k) => k.key)).toEqual([
      "model",
      "language",
      "permissionMode",
      "verbose",
      "newKey",
    ]);
    expect(config.keys.find((k) => k.key === "verbose")).toEqual({
      key: "verbose",
      group: "other",
      kind: "boolean",
      value: true,
    });
    // A key the app does not know goes last, set nowhere.
    expect(config.keys.at(-1)).toEqual({ key: "newKey", group: "other", kind: "boolean" });
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.outputStyles).toEqual(["default", "Mine"]);
    // Only the default efforts, nothing else of the settings.
    expect(config.efforts).toEqual({ level: "low", byModel: { "claude-opus-5-5": "xhigh" } });
    expect(JSON.stringify(config)).not.toContain("SECRET");
  });

  test("no default effort where its program cannot save one", () => {
    expect(told(false).efforts).toBeUndefined();
    expect(configShownOf(told(false)).effort).toBe(false);
  });

  test("shown there as the dialog here shows its own", () => {
    const shown = configShownOf(told());
    expect(shown.values.verbose).toBe(true);
    expect(shown.values.model).toBe("opus");
    expect(shown.effort).toBe(true);
    expect(shown.effective).toEqual({
      effortLevel: "low",
      modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } },
    });
    expect(shown.models).toEqual(models);
  });
});

describe("the changes another device saves", () => {
  test("become the /config messages the dialog here sends, the unchanged left out", () => {
    expect(
      configSetOf(
        { changes: { verbose: false, model: "sonnet", language: "한국어 존댓말" } },
        told(),
      ),
    ).toEqual({
      messages: ["/config model=sonnet verbose=false", "/config language=한국어 존댓말"],
      model: "sonnet",
    });
    expect(configSetOf({ changes: { verbose: true } }, told())).toEqual({ messages: [] });
  });

  test("only keys it shows, of the kind they take, a choice one of its own", () => {
    const refused = (changes: Record<string, boolean | string>) => () =>
      configSetOf({ changes }, told());
    expect(refused({ apiKeyHelper: "x" })).toThrow(ConfigRefusal);
    expect(refused({ verbose: "yes" })).toThrow('"verbose" takes true or false');
    expect(refused({ language: true })).toThrow('"language" takes text');
    expect(refused({ model: "gpt" })).toThrow('"model" cannot be "gpt"');
  });

  test("not the mode that lets everything run, though its CLI lists it", () => {
    expect(() => configSetOf({ changes: { permissionMode: "bypassPermissions" } }, told())).toThrow(
      "not set from another device",
    );
    expect(configSetOf({ changes: { permissionMode: "plan" } }, told()).messages).toEqual([
      "/config permissionMode=plan",
    ]);
  });

  test("a default effort the model then run takes, but max", () => {
    expect(configSetOf({ changes: {}, effort: "xhigh" }, told()).effort).toBe("xhigh");
    // The new default model's levels.
    expect(configSetOf({ changes: { model: "sonnet" }, effort: "high" }, told()).effort).toBe(
      "high",
    );
    expect(() => configSetOf({ changes: {}, effort: "high" }, told())).toThrow(
      'the default effort cannot be "high"',
    );
    expect(() => configSetOf({ changes: { model: "sonnet" }, effort: "max" }, told())).toThrow(
      ConfigRefusal,
    );
    expect(() => configSetOf({ changes: {}, effort: "low" }, told(false))).toThrow(ConfigRefusal);
  });
});
