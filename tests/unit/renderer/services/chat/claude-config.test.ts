import { describe, expect, test } from "bun:test";
import {
  configKeysOf,
  configMessages,
  configUsageOf,
  configValues,
  defaultEffortOf,
  effortModelOf,
  parseConfigUsage,
} from "../../../../../src/renderer/services/chat/claude-config";
import { remoteAtStartup } from "../../../../../src/renderer/services/chat/settings-defaults";

// A bare /config's answer, as `claude -p --output-format json "/config"` gives it (2.1.321, cut).
const USAGE = [
  "Usage: /config key=value [key=value ...]",
  "  autoCompact=true|false",
  "  language=<value>",
  "  model=default|sonnet|opus|haiku|fable|best|sonnet[1m]|opus[1m]|fable[1m]|opusplan",
  "  remoteControl=true|false|default",
  "  someNewKey=a|b",
  "  theme=auto|dark|light",
].join("\n");

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

describe("the keys /config lists", () => {
  test("parsed from the CLI's JSON answer: on/off, text and choices", () => {
    const listed = parseConfigUsage(configUsageOf(JSON.stringify({ result: USAGE })));
    expect(listed).toContainEqual({ key: "autoCompact", kind: "boolean" });
    expect(listed).toContainEqual({ key: "language", kind: "text" });
    expect(listed).toContainEqual({
      key: "remoteControl",
      kind: "choice",
      options: ["true", "false", "default"],
    });
    expect(listed.find((k) => k.key === "model")?.options).toContain("opus[1m]");
  });

  test("the dialog shows what the CLI lists: known keys as the table has them, new ones last", () => {
    const keys = configKeysOf(parseConfigUsage(USAGE));
    expect(keys.map((k) => k.key)).toEqual([
      "model",
      "autoCompact",
      "language",
      "remoteControl",
      "theme",
      "someNewKey",
    ]);
    expect(keys.find((k) => k.key === "remoteControl")?.setting).toBe("remoteControlAtStartup");
    expect(keys.find((k) => k.key === "someNewKey")).toEqual({
      key: "someNewKey",
      group: "other",
      kind: "choice",
      options: ["a", "b"],
    });
    // Without the CLI's list, the table.
    expect(configKeysOf(null).length).toBeGreaterThan(30);
  });

  test("remote control at startup reads as on, off or the default", () => {
    const keys = configKeysOf(parseConfigUsage(USAGE));
    expect(configValues({ remoteControlAtStartup: true }, {}, keys).remoteControl).toBe("true");
    expect(configValues({}, { remoteControlAtStartup: false }, keys).remoteControl).toBe("false");
    expect(configValues({}, {}, keys).remoteControl).toBe("default");
    expect(configMessages({ remoteControl: "true", model: "opus" }, keys)).toEqual([
      "/config model=opus remoteControl=true",
    ]);
  });
});

describe("the default effort", () => {
  const models = [
    { value: "opus", displayName: "Opus 5.5", resolvedModel: "claude-opus-5-5" },
    { value: "haiku", displayName: "Haiku 5.5", resolvedModel: "claude-haiku-5-5" },
  ];

  test("the model's own, else effortLevel", () => {
    const effective = {
      effortLevel: "high",
      modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } },
    };
    expect(defaultEffortOf(effective, "claude-opus-5-5")).toBe("xhigh");
    expect(defaultEffortOf(effective, "claude-haiku-5-5")).toBe("high");
    expect(defaultEffortOf({}, "claude-haiku-5-5")).toBeUndefined();
  });

  test("of the new default model when the draft changes it, else the session's", () => {
    expect(effortModelOf("haiku", "claude-opus-5-5", models)?.id).toBe("claude-haiku-5-5");
    expect(effortModelOf("opus[1m]", "claude-haiku-5-5", models)?.id).toBe("claude-opus-5-5");
    expect(effortModelOf(undefined, "claude-opus-5-5", models)?.info?.displayName).toBe("Opus 5.5");
  });
});

describe("remoteAtStartup", () => {
  test("on when the user set it and it can be; the gate can hold it back", () => {
    const init = { remote_control_available: true, remote_control_auto_enable: true };
    expect(remoteAtStartup(init)).toBe(true);
    expect(remoteAtStartup({ ...init, remote_control_auto_enable: false })).toBe(false);
    expect(remoteAtStartup({ ...init, remote_control_available: false })).toBe(false);
    expect(remoteAtStartup({ ...init, ide_rc_auto_enable_gate: false })).toBe(false);
  });
});
