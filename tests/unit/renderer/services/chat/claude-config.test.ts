import { describe, expect, test } from "bun:test";
import {
  configMessages,
  configValues,
} from "../../../../../src/renderer/services/chat/claude-config";

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
