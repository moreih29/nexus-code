import { describe, expect, test } from "bun:test";
import {
  CONFIG_KEYS,
  changesOf,
  choicesOf,
  configCommandOf,
  configMessages,
  configValues,
} from "../../../../../src/renderer/services/chat/claude-config";

const keyOf = (name: string) => {
  const key = CONFIG_KEYS.find((k) => k.key === name);
  if (!key) throw new Error(`no key ${name}`);
  return key;
};

describe("configValues", () => {
  test("settings.json first, then the global config file, then the fallback", () => {
    const values = configValues(
      { autoCompactEnabled: false, permissions: { defaultMode: "plan" }, theme: "light" },
      { autoCompactEnabled: true, theme: "dark-ansi", respectGitignore: false, verbose: true },
    );
    expect(values.autoCompact).toBe(false);
    expect(values.permissionMode).toBe("plan");
    expect(values.theme).toBe("light");
    expect(values.gitignore).toBe(false);
    expect(values.verbose).toBe(true);
    expect(values.checkpoints).toBe(true);
    expect(values.worktreeBaseRef).toBe("fresh");
  });

  test("a key set nowhere without a known fallback is unknown", () => {
    const values = configValues({}, {});
    expect(values.workflows).toBeUndefined();
    expect(values.switchModelsOnFlag).toBeUndefined();
    expect(values.workflowSizeGuideline).toBeUndefined();
    expect(values.language).toBe("");
  });

  test("a value of the wrong type is not taken", () => {
    const values = configValues({ autoCompactEnabled: "no", outputStyle: 3 }, {});
    expect(values.autoCompact).toBe(true);
    expect(values.outputStyle).toBe("default");
  });

  test("disableWorkflows turns workflows off; emacs shows as normal", () => {
    const values = configValues(
      { enableWorkflows: true, disableWorkflows: true, editorMode: "emacs" },
      {},
    );
    expect(values.workflows).toBe(false);
    expect(values.editor).toBe("normal");
  });
});

describe("choicesOf", () => {
  test("the output styles the CLI names, and a value the list lacks", () => {
    expect(choicesOf(keyOf("outputStyle"), "Mine", ["default", "Mine"])).toEqual([
      "default",
      "Mine",
    ]);
    expect(choicesOf(keyOf("theme"), "custom:ocean")).toContain("custom:ocean");
    expect(choicesOf(keyOf("worktreeBaseRef"), undefined)).toEqual(["fresh", "head"]);
  });
});

describe("configMessages", () => {
  test("one-word values go in one message, a value with a space alone", () => {
    expect(
      configMessages({ verbose: true, language: "Korean formal", permissionMode: "plan" }),
    ).toEqual(["/config permissionMode=plan verbose=true", "/config language=Korean formal"]);
  });

  test("the language emptied goes back to its default; nothing changed sends nothing", () => {
    expect(configMessages({ language: "  " })).toEqual(["/config language=default"]);
    expect(configMessages({})).toEqual([]);
  });
});

describe("configCommandOf", () => {
  test("bare commands open the dialog, at their setting", () => {
    expect(configCommandOf("/config")).toEqual({});
    expect(configCommandOf(" /Settings ")).toEqual({});
    expect(configCommandOf("/output-style")).toEqual({ focus: "outputStyle" });
    expect(configCommandOf("/autocompact")).toEqual({ focus: "autoCompact" });
  });

  test("with arguments, or another command, it is the CLI's", () => {
    expect(configCommandOf("/config verbose=true")).toBeNull();
    expect(configCommandOf("/output-style Concise")).toBeNull();
    expect(configCommandOf("/model")).toBeNull();
    expect(configCommandOf("config")).toBeNull();
  });
});

describe("changesOf", () => {
  test("only what differs from now", () => {
    expect(
      changesOf(
        { autoCompact: true, verbose: true, language: " korean ", theme: "dark" },
        { autoCompact: true, verbose: false, language: "korean", theme: undefined },
      ),
    ).toEqual({ verbose: true, theme: "dark" });
  });
});
