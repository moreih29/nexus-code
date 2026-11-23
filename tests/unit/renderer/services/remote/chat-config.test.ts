import { describe, expect, test } from "bun:test";
import { RPC_METHODS } from "../../../../../packages/remote-protocol/src";
import {
  CodexConfigRefusal,
  codexConfigEdits,
  codexConfigSnapshot,
} from "../../../../../src/renderer/services/chat/codex/config";
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
    expect(config.keys.at(-1)).toEqual({ key: "newKey", group: "other", kind: "boolean" });
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.outputStyles).toEqual(["default", "Mine"]);
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

describe("Codex profile defaults over chat.config", () => {
  const models = [
    {
      value: "gpt-a",
      isDefault: true,
      supportedEffortLevels: ["low", "high"],
      serviceTiers: ["priority"],
    },
    { value: "gpt-b", supportedEffortLevels: ["medium"] },
  ];
  const read = {
    config: {
      model: null,
      model_reasoning_effort: "low",
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
      service_tier: "fast",
      web_search: "disabled",
      model_providers: { secretField: "private" },
    },
  };
  const noRequirements = { requirements: null };
  const options = (snapshot: ReturnType<typeof codexConfigSnapshot>, name: string) =>
    snapshot.shown.keys.find(({ key }) => key === name)?.options;

  test("passes through the existing RPC schema and preserves the running model separately", () => {
    const snapshot = codexConfigSnapshot(read, noRequirements, models, true, "gpt-b");
    const { config } = RPC_METHODS["chat.config"].result.parse({ config: snapshot.shown });
    expect(config?.keys[0]).toMatchObject({ key: "model", value: "gpt-a" });
    expect(config?.model).toBe("gpt-b");
    expect(config?.efforts).toEqual({ level: "low", byModel: {} });
    expect(config?.keys.find(({ key }) => key === "service_tier")).toMatchObject({
      value: "priority",
      options: ["default", "priority"],
    });
    expect(JSON.stringify(config)).not.toContain("secretField");
  });

  test("enforces managed requirements and profile/project overrides", () => {
    const snapshot = codexConfigSnapshot(
      {
        ...read,
        origins: { web_search: { name: { type: "project" } } },
        layers: [
          { name: { type: "user", profile: "work" }, version: "profile-version" },
          { name: { type: "user", profile: null }, version: "base-version" },
        ],
      },
      {
        requirements: {
          allowedApprovalPolicies: ["on-request", "untrusted", { granular: {} }],
          allowedSandboxModes: ["read-only"],
          featureRequirements: { fast_mode: false },
        },
      },
      models,
      false,
    );
    expect(snapshot.version).toBe("profile-version");
    expect(options(snapshot, "approval_policy")).toEqual(["on-request"]);
    expect(options(snapshot, "sandbox_mode")).toEqual(["read-only"]);
    expect(options(snapshot, "service_tier")).toEqual(["default"]);
    expect(options(snapshot, "web_search")).toEqual([]);
    expect(() => codexConfigEdits({ changes: { web_search: "cached" } }, snapshot, false)).toThrow(
      CodexConfigRefusal,
    );
    expect(() =>
      codexConfigEdits({ changes: { sandbox_mode: "workspace-write" } }, snapshot, false),
    ).toThrow(CodexConfigRefusal);
  });

  test("offers Indexed on verified versions and retains Disabled under search requirements", () => {
    const current = codexConfigSnapshot(read, noRequirements, models, false, undefined, "0.170.0");
    expect(options(current, "web_search")).toContain("indexed");
    const restricted = codexConfigSnapshot(
      read,
      { requirements: { allowedWebSearchModes: [] } },
      models,
      false,
      undefined,
      "0.170.0",
    );
    expect(options(restricted, "web_search")).toEqual(["disabled"]);
  });

  test("rejects raw remote permission escalation, including unchanged values and arbitrary keys", () => {
    const snapshot = codexConfigSnapshot(read, noRequirements, models, true);
    expect(options(snapshot, "approval_policy")).not.toContain("never");
    expect(options(snapshot, "sandbox_mode")).not.toContain("danger-full-access");
    for (const changes of [
      { sandbox_mode: "danger-full-access" },
      { approval_policy: "never" },
      { "sandbox_workspace_write.writable_roots": "/" },
      { "features.fast_mode": true },
      { web_search: true },
    ]) {
      const params = RPC_METHODS["chat.config"].params.parse({
        workspaceId: "w",
        tabId: "t",
        set: { changes },
      });
      expect(() => codexConfigEdits(params.set!, snapshot, true)).toThrow(CodexConfigRefusal);
    }
    const broad = codexConfigSnapshot(
      {
        config: { ...read.config, sandbox_workspace_write: { writable_roots: ["/"] } },
      },
      noRequirements,
      models,
      true,
    );
    expect(options(broad, "sandbox_mode")).toEqual(["read-only"]);
    expect(() =>
      codexConfigEdits({ changes: { sandbox_mode: "workspace-write" } }, broad, true),
    ).toThrow(CodexConfigRefusal);
  });

  test("a trusted project cannot mask broader profile-wide workspace-write settings", () => {
    const scoped = {
      config: {
        ...read.config,
        sandbox_mode: "read-only",
        sandbox_workspace_write: { network_access: false, writable_roots: [] },
      },
      layers: [
        {
          name: { type: "project" },
          config: { sandbox_workspace_write: { network_access: false, writable_roots: [] } },
        },
        {
          name: { type: "user" },
          config: { sandbox_workspace_write: { network_access: true, writable_roots: ["/tmp"] } },
        },
      ],
    };
    const remote = codexConfigSnapshot(scoped, noRequirements, models, true);
    expect(options(remote, "sandbox_mode")).toEqual(["read-only"]);
    expect(() =>
      codexConfigEdits({ changes: { sandbox_mode: "workspace-write" } }, remote, true),
    ).toThrow(CodexConfigRefusal);
    const local = codexConfigSnapshot(scoped, noRequirements, models, false);
    expect(options(local, "sandbox_mode")).toContain("workspace-write");
  });

  test("validates effort and service tier against the requested model", () => {
    const snapshot = codexConfigSnapshot(
      { config: { ...read.config, service_tier: null } },
      noRequirements,
      models,
      true,
    );
    expect(
      codexConfigEdits(
        { changes: { model: "gpt-b", web_search: "cached" }, effort: "medium" },
        snapshot,
        true,
      ),
    ).toEqual([
      { keyPath: "model", value: "gpt-b", mergeStrategy: "replace" },
      { keyPath: "web_search", value: "cached", mergeStrategy: "replace" },
      { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" },
    ]);
    expect(codexConfigEdits({ changes: { service_tier: "priority" } }, snapshot, true)).toEqual([
      { keyPath: "service_tier", value: "fast", mergeStrategy: "replace" },
    ]);
    expect(() =>
      codexConfigEdits({ changes: { model: "gpt-b" }, effort: "low" }, snapshot, true),
    ).toThrow(CodexConfigRefusal);
    expect(() =>
      codexConfigEdits({ changes: { model: "gpt-b", service_tier: "priority" } }, snapshot, true),
    ).toThrow(CodexConfigRefusal);
  });

  test("leaves old app-server fields usable without guessing at new options", () => {
    const legacy = codexConfigSnapshot({ config: { model: "gpt-a" } }, undefined, models, true);
    expect(legacy.shown.keys.map(({ key }) => key)).toEqual(["model"]);
    expect(codexConfigEdits({ changes: {}, effort: "high" }, legacy, true)).toEqual([
      { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "replace" },
    ]);
    const unknownRequirements = codexConfigSnapshot(read, undefined, models, true);
    expect(options(unknownRequirements, "sandbox_mode")).toEqual([]);
    expect(options(unknownRequirements, "service_tier")).toEqual([]);
  });

  const threshold = "model_auto_compact_token_limit";
  const postTurn = "model_post_turn_compact_threshold_percent";
  const scope = "model_auto_compact_token_limit_scope";
  const planEffort = "plan_mode_reasoning_effort";

  test("advertises automatic, then writes exact numbers from the existing peer wire", () => {
    const snapshot = codexConfigSnapshot(
      { config: { [threshold]: null, [postTurn]: null, model_context_window: null } },
      noRequirements,
      models,
      true,
    );
    const { config } = RPC_METHODS["chat.config"].result.parse({ config: snapshot.shown });
    expect(config?.keys.find(({ key }) => key === threshold)).toEqual({
      key: threshold,
      group: "conversation",
      kind: "text",
    });
    const params = RPC_METHODS["chat.config"].params.parse({
      workspaceId: "w",
      tabId: "t",
      set: {
        changes: {
          [threshold]: "400000",
          [postTurn]: "0",
          model_context_window: "9007199254740991",
        },
      },
    });
    expect(codexConfigEdits(params.set!, snapshot, true)).toEqual([
      { keyPath: threshold, value: 400000, mergeStrategy: "replace" },
      { keyPath: postTurn, value: 0, mergeStrategy: "replace" },
      { keyPath: "model_context_window", value: Number.MAX_SAFE_INTEGER, mergeStrategy: "replace" },
    ]);
    expect(codexConfigEdits({ changes: { [threshold]: "" } }, snapshot, true)).toEqual([]);
    for (const value of [
      "0",
      "-1",
      "+1",
      "01",
      "1.5",
      "1e5",
      " 1",
      "1\n",
      "9007199254740992",
      true,
    ]) {
      expect(() => codexConfigEdits({ changes: { [threshold]: value } }, snapshot, true)).toThrow(
        CodexConfigRefusal,
      );
    }
    expect(() => codexConfigEdits({ changes: { [postTurn]: "101" } }, snapshot, true)).toThrow(
      CodexConfigRefusal,
    );
  });

  test("allows an oversized stored integer to be reset without returning a rounded value", () => {
    const snapshot = codexConfigSnapshot(
      { config: { [threshold]: 2 ** 63, [scope]: "total", model_reasoning_summary: "none" } },
      noRequirements,
      models,
      true,
    );
    const { config } = RPC_METHODS["chat.config"].result.parse({ config: snapshot.shown });
    expect(config?.keys.find(({ key }) => key === threshold)).toEqual({
      key: threshold,
      group: "conversation",
      kind: "text",
      valueUnavailable: true,
    });
    expect(
      codexConfigEdits(
        {
          changes: { [threshold]: "", [scope]: "default", model_reasoning_summary: "auto" },
        },
        snapshot,
        true,
      ),
    ).toEqual([
      { keyPath: threshold, value: null, mergeStrategy: "replace" },
      { keyPath: scope, value: null, mergeStrategy: "replace" },
      { keyPath: "model_reasoning_summary", value: "auto", mergeStrategy: "replace" },
    ]);
  });

  test("binds edits to the active named user file and refuses stronger config layers", () => {
    const named = { type: "user", profile: "work", file: "/alpha/work.config.toml" };
    const base = { type: "user", profile: null, file: "/alpha/config.toml" };
    const snapshot = codexConfigSnapshot(
      {
        config: {
          [threshold]: 400000,
          [postTurn]: 75,
          [scope]: "total",
          model_verbosity: "medium",
          [planEffort]: "low",
        },
        origins: {
          [threshold]: { name: named },
          [postTurn]: { name: { type: "project" } },
          [scope]: { name: { type: "sessionFlags" } },
          model_verbosity: { name: base },
        },
        layers: [
          { name: named, version: "work-version", config: { [threshold]: 400000 } },
          { name: base, version: "base-version", config: { model_verbosity: "medium" } },
        ],
      },
      noRequirements,
      models,
      true,
    );
    expect(snapshot.filePath).toBe(named.file);
    expect(snapshot.version).toBe("work-version");
    expect(options(snapshot, postTurn)).toEqual([]);
    expect(options(snapshot, scope)).toEqual([]);
    expect(options(snapshot, planEffort)).toEqual(["default", "low", "high"]);
    expect(
      codexConfigEdits(
        {
          changes: { [threshold]: "", model_verbosity: "default" },
        },
        snapshot,
        true,
      ),
    ).toEqual([{ keyPath: threshold, value: null, mergeStrategy: "replace" }]);
    expect(() => codexConfigEdits({ changes: { [postTurn]: "" } }, snapshot, true)).toThrow(
      CodexConfigRefusal,
    );
    expect(() =>
      codexConfigEdits({ changes: { model: "gpt-b", [planEffort]: "high" } }, snapshot, true),
    ).toThrow(CodexConfigRefusal);
  });
});
