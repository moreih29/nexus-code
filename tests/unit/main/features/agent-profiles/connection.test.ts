import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionKeys } from "../../../../../src/main/features/agent-profiles/connection-keys";
import {
  claudeConnectionEnv,
  claudeModelPicker,
  codexConnectionArgs,
  codexConnectionCatalog,
  codexConnectionEnv,
  sameLaunchConnection,
} from "../../../../../src/main/features/agent-profiles/connection-launch";
import {
  classifyConnectionError,
  connectionEndpoint,
  discoverConnectionModels,
  discoveredModels,
  testConnection,
} from "../../../../../src/main/features/agent-profiles/connection-probe";
import { pruneProfileKeys } from "../../../../../src/main/features/agent-profiles/connection-save";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import {
  ConnectionModelSchema,
  type CustomConnection,
  connectionDefaultModel,
  connectionKeyTarget,
  connectionPreset,
  connectionReasoningLevels,
  normalizeConnectionUrl,
} from "../../../../../src/shared/agent-profiles/connection";
import { mergeAgentEnv } from "../../../../../src/shared/agent-profiles/env";
import {
  type AgentProfile,
  AgentProfileSchema,
  AgentProfilesSchema,
  EMPTY_AGENT_PROFILES,
  profilesOf,
} from "../../../../../src/shared/agent-profiles/profiles";
import { openTestState } from "../../../../helpers/test-state";

const connection: CustomConnection = {
  method: "custom",
  baseUrl: "http://localhost:1234/",
  auth: "x-api-key",
  preset: "lmstudio",
  defaultModel: "main/model",
  lightModel: "small",
  contextWindow: 65_536,
  models: [
    { id: "small", label: "Small", reasoning: "high", contextWindow: 4096 },
    { id: "main/model", label: "Main" },
  ],
  advanced: {
    headers: { "X-Route": "test" },
    query: { audience: "local" },
    retries: 0,
    timeoutMs: 2500,
    maxOutputTokens: 2048,
    streamIdleTimeoutMs: 3000,
    disableExperimentalBetas: true,
  },
};

const profile: AgentProfile = {
  id: "claude-default",
  name: "",
  agent: "claude",
  color: "blue",
  dir: "",
  connection,
};

describe("profile connections", () => {
  test("only launch-affecting edits change the connection", () => {
    expect(sameLaunchConnection(profile, { ...profile, name: "New name", color: "red" })).toBe(
      true,
    );
    expect(
      sameLaunchConnection(
        { ...profile, connection: undefined },
        { ...profile, connection: { method: "account" } },
      ),
    ).toBe(true);
    for (const edit of [
      { baseUrl: "https://example.com" },
      { auth: "bearer" },
      { models: [...connection.models].reverse() },
      { defaultModel: "small" },
      { lightModel: "main/model" },
      { contextWindow: 200_000 },
      { advanced: { ...connection.advanced, timeoutMs: 3_000 } },
    ] satisfies Partial<CustomConnection>[]) {
      expect(
        sameLaunchConnection(profile, { ...profile, connection: { ...connection, ...edit } }),
      ).toBe(false);
    }
  });

  test("uses Kimi Code's API-key header and LiteLLM's documented self-hosted addresses", () => {
    expect(connectionPreset("claude", "kimi")).toEqual({
      baseUrl: "https://api.kimi.ai/coding",
      auth: "x-api-key",
    });
    expect(connectionPreset("claude", "litellm")).toEqual({
      baseUrl: "http://localhost:4000",
      auth: "bearer",
    });
    expect(connectionPreset("codex", "litellm")).toEqual({
      baseUrl: "http://localhost:4000/v1",
      auth: "bearer",
    });
  });

  test("retains old profiles and never puts the API key field into profile state", () => {
    const { connection: _connection, ...old } = profile;
    expect(AgentProfileSchema.parse(old)).toEqual(old);
    expect(connectionDefaultModel(old)).toBeUndefined();
    const config = AgentProfilesSchema.parse({
      profiles: [{ ...profile, connection: { ...connection, key: "do-not-persist" } }],
      rules: [],
      defaults: {},
    });
    const resolved = profilesOf(config, "claude")[0];
    expect(resolved?.connection).toEqual(connection);
    expect(connectionDefaultModel(profile)).toBe("main/model");
    expect(JSON.stringify(resolved)).not.toContain("do-not-persist");
  });

  test("reads old model rows and shares the same effort levels with both agents", () => {
    expect(ConnectionModelSchema.parse({ id: "legacy" })).toEqual({ id: "legacy" });
    expect(ConnectionModelSchema.parse({ id: "maximum", reasoning: "max" })).toEqual({
      id: "maximum",
      reasoning: "max",
    });
    expect(connectionReasoningLevels(undefined)).toEqual([]);
    expect(connectionReasoningLevels("high")).toEqual(["low", "medium", "high"]);
    expect(connectionReasoningLevels("xhigh")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(connectionReasoningLevels("max")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("normalizes bases and preserves gateway prefixes and Codex query options", () => {
    expect(normalizeConnectionUrl("claude", "https://example.com/api/v1/")).toBe(
      "https://example.com/api",
    );
    expect(normalizeConnectionUrl("codex", "http://localhost:1234/")).toBe(
      "http://localhost:1234/v1",
    );
    expect(
      connectionEndpoint(
        {
          agent: "codex",
          baseUrl: "https://example.com/v1/",
          query: { name: "a/b" },
        },
        "models",
      ).href,
    ).toBe("https://example.com/v1/models?name=a%2Fb");
    expect(() => normalizeConnectionUrl("claude", "file:///tmp/config")).toThrow();
    expect(() => normalizeConnectionUrl("codex", "https://user:secret@example.com/v1")).toThrow();
    expect(() => normalizeConnectionUrl("codex", "https://example.com/v1?key=secret")).toThrow();
  });

  test("maps Claude aliases and advanced options, with case-insensitive precedence on Windows", () => {
    const env = claudeConnectionEnv(connection, "local-test-key");
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:1234",
      ANTHROPIC_API_KEY: "local-test-key",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "main/model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "small",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Small",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "main/model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "main/model",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "main/model",
      CLAUDE_CODE_MODEL_CAPABILITIES: "small=effort,-xhigh_effort,-max_effort",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "65536",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
      ANTHROPIC_CUSTOM_HEADERS: "X-Route: test",
      API_TIMEOUT_MS: "2500",
    });
    expect(mergeAgentEnv(true, { anthropic_api_key: "old" }, env)).not.toHaveProperty(
      "anthropic_api_key",
    );
    expect(claudeConnectionEnv({ method: "api-key" }, "test")).toMatchObject({
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    });
    expect(claudeModelPicker(connection)?.options).toEqual([
      { model: "small", label: "Small" },
      { model: "main/model", label: "Main" },
    ]);
    expect(claudeModelPicker(undefined)).toBeUndefined();
  });

  test("leaves existing Claude profiles on Claude Code defaults until reasoning is explicit", () => {
    const automatic: CustomConnection = {
      ...connection,
      defaultModel: "main/model",
      models: [{ id: "main/model" }],
    };
    expect(claudeConnectionEnv(automatic, undefined)).not.toHaveProperty(
      "CLAUDE_CODE_MODEL_CAPABILITIES",
    );
    expect(
      claudeConnectionEnv(
        { ...automatic, models: [{ id: "main/model", reasoning: "none" }] },
        undefined,
      ).CLAUDE_CODE_MODEL_CAPABILITIES,
    ).toBe("main/model=-effort,-xhigh_effort,-max_effort");
  });

  test("bounds Claude effort per model and leaves unrepresentable IDs automatic", () => {
    const custom: CustomConnection = {
      ...connection,
      defaultModel: "UPPER[1m]",
      models: [{ id: "UPPER[1m]", reasoning: "xhigh" }],
    };
    expect(claudeConnectionEnv(custom, undefined).CLAUDE_CODE_MODEL_CAPABILITIES).toBe(
      "upper=effort,xhigh_effort,-max_effort",
    );
    expect(
      claudeConnectionEnv({ ...custom, models: [{ id: "UPPER[1m]", reasoning: "max" }] }, undefined)
        .CLAUDE_CODE_MODEL_CAPABILITIES,
    ).toBe("upper=effort,xhigh_effort,max_effort");
    for (const id of ["model;other", "model,other", "model=other", "model*"]) {
      for (const reasoning of ["none", "high"] as const) {
        const env = claudeConnectionEnv(
          {
            ...custom,
            defaultModel: id,
            models: [
              { id, reasoning },
              { id: "UPPER[1m]", reasoning: "xhigh" },
            ],
          },
          undefined,
        );
        expect(env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe("upper=effort,xhigh_effort,-max_effort");
      }
      expect(
        claudeConnectionEnv({ ...custom, defaultModel: id, models: [{ id }] }, undefined),
      ).not.toHaveProperty("CLAUDE_CODE_MODEL_CAPABILITIES");
    }
  });

  test("builds Codex provider overrides and a model catalog without exposing keys in args", () => {
    const path = "C:\\Users\\Test User\\models.json";
    const args = codexConnectionArgs(connection, "local-test-key", path).join("\n");
    expect(args).toContain(`model_catalog_json=${JSON.stringify(path)}`);
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('wire_api = "responses"');
    expect(args).toContain('query_params = { "audience" = "local" }');
    expect(args).toContain('http_headers = { "X-Route" = "test" }');
    expect(args).toContain("request_max_retries = 0");
    expect(args).toContain("stream_max_retries = 0");
    expect(args).toContain("stream_idle_timeout_ms = 3000");
    expect(args).not.toContain("local-test-key");
    expect(args).toContain('env_key = "NEXUS_PROFILE_CODEX_API_KEY"');
    expect(codexConnectionArgs(connection, undefined, path).join(" ")).not.toContain("env_key");
    expect(codexConnectionArgs({ method: "api-key" }, "test").join(" ")).toContain(
      "https://api.openai.com/v1",
    );
    expect(codexConnectionEnv(connection, "local-test-key")).toMatchObject({
      NEXUS_PROFILE_CODEX_API_KEY: "local-test-key",
    });
    const { models } = codexConnectionCatalog(connection);
    expect(models[0]).toMatchObject({
      slug: "main/model",
      display_name: "Main",
      priority: 0,
      context_window: 131_072,
      supported_reasoning_levels: [],
      default_reasoning_level: null,
    });
    expect(models[0]?.base_instructions.length).toBeGreaterThan(1000);
    expect(models[1]?.context_window).toBe(4096);
    expect(models[1]?.supported_reasoning_levels.map(({ effort }) => effort)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    const [maximum] = codexConnectionCatalog({
      ...connection,
      defaultModel: "maximum",
      models: [{ id: "maximum", reasoning: "max" }],
    }).models;
    expect(maximum?.default_reasoning_level).toBe("low");
    expect(maximum?.supported_reasoning_levels.map(({ effort }) => effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("keeps keys bound to their endpoint, reports only a suffix, and clears removed profiles", async () => {
    const keys = new ConnectionKeys(keptInMemory(), false);
    const target = connectionKeyTarget("claude", connection);
    expect(await keys.saveProfile(profile, "test-test-1234", () => {})).toBe(true);
    expect(await keys.saveProfile(profile, "test-test-1234", () => {})).toBe(false);
    expect(await keys.status(profile.id, target)).toEqual({
      present: true,
      last4: "1234",
      persistent: false,
    });
    expect(
      await keys.get(profile.id, connectionKeyTarget("claude", { ...connection, auth: "bearer" })),
    ).toBeUndefined();
    await expect(
      keys.saveProfile(profile, "replacement", () => {
        throw new Error("state write failed");
      }),
    ).rejects.toThrow("state write failed");
    expect(await keys.get(profile.id, target)).toBe("test-test-1234");
    await keys.saveProfile(profile, "123", () => {});
    expect((await keys.status(profile.id, target)).last4).toBeUndefined();
    await keys.prune(() => new Set());
    expect(await keys.get(profile.id, target)).toBeUndefined();
  });

  test("flushes profile removal before deleting its key and keeps the key on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-profile-prune-"));
    const filePath = join(dir, "state.json");
    const state = openTestState(filePath);
    const storage = keptInMemory<Record<string, { target: string; key: string }>>();
    const keys = new ConnectionKeys(storage, true);
    const target = connectionKeyTarget("claude", connection);
    const removed = {
      ...profile,
      id: "claude-prune-test",
      name: "Prune test",
      dir: "/profiles/prune-test",
    };
    await keys.saveProfile(removed, "prune-test-key", () => {
      state.commitState({ agentProfiles: { ...EMPTY_AGENT_PROFILES, profiles: [removed] } });
    });
    state.setState({ agentProfiles: EMPTY_AGENT_PROFILES });
    const flush = spyOn(state, "flushNow").mockImplementationOnce(() => {
      throw new Error("state write failed");
    });
    const originalSave = storage.save.bind(storage);
    const save = spyOn(storage, "save").mockImplementation(async (value) => {
      expect(openTestState(filePath).getState().agentProfiles?.profiles).toEqual([]);
      await originalSave(value);
    });
    try {
      await expect(pruneProfileKeys(keys, state)).rejects.toThrow("state write failed");
      expect(await keys.get(removed.id, target)).toBe("prune-test-key");
      expect(save).not.toHaveBeenCalled();
      await pruneProfileKeys(keys, state);
      expect(save).toHaveBeenCalledTimes(1);
      expect(await keys.get(removed.id, target)).toBeUndefined();
    } finally {
      flush.mockRestore();
      save.mockRestore();
      state.flushNow();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds a dormant key only for the same profile, normalized URL and auth", async () => {
    const keys = new ConnectionKeys(keptInMemory(), true);
    const target = connectionKeyTarget("claude", connection);
    await keys.saveProfile(profile, "dormant-1234", () => {});
    expect(await keys.saveProfile({ ...profile, connection: undefined }, undefined, () => {})).toBe(
      false,
    );
    expect(await keys.status(profile.id)).toEqual({ present: false, persistent: true });
    const other = { ...profile, connection: { ...connection, baseUrl: "https://another.test" } };
    const otherTarget = connectionKeyTarget("claude", other.connection);
    await keys.saveProfile(other, null, () => {});
    expect((await keys.status(profile.id, otherTarget)).present).toBe(false);
    expect(
      (
        await keys.status(
          profile.id,
          connectionKeyTarget("claude", { ...connection, auth: "bearer" }),
        )
      ).present,
    ).toBe(false);
    expect((await keys.status("another-profile", target)).present).toBe(false);
    expect((await keys.status(profile.id, target)).last4).toBe("1234");
    expect(await keys.saveProfile(profile, null, () => {})).toBe(true);
    expect((await keys.status(profile.id, target)).present).toBe(false);
  });

  test("classifies HTTP failures without returning provider response bodies", () => {
    expect(classifyConnectionError(403, "private", "test", false)).toEqual({
      ok: false,
      reason: "auth",
      status: 403,
    });
    expect(classifyConnectionError(404, '{"code":"model_not_found"}', "test", true).reason).toBe(
      "model",
    );
    expect(classifyConnectionError(404, "Not Found", "test", true).reason).toBe("address");
    expect(classifyConnectionError(405, "Method Not Allowed", "test", true).reason).toBe(
      "unsupported",
    );
  });

  test("uses the model metadata and matches Ollama sizes by ID", () => {
    expect(
      discoveredModels(
        {
          data: [
            { id: "installed", display_name: "Installed", meta: { n_ctx: 16384 } },
            { id: "installed" },
          ],
        },
        { models: [{ name: "installed", size: 3000 }] },
      ),
    ).toEqual([{ id: "installed", label: "Installed", contextWindow: 16384, bytes: 3000 }]);
  });

  test("queries a loopback server and distinguishes a Chat Completions-only address without a second POST", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        methods.push(`${request.method} ${pathname}`);
        if (request.headers.get("authorization") !== "Bearer test")
          return new Response(null, { status: 401 });
        if (pathname === "/v1/models") return Response.json({ data: [{ id: "model" }] });
        return new Response(null, { status: pathname === "/v1/chat/completions" ? 405 : 404 });
      },
    });
    try {
      const args = { agent: "codex" as const, baseUrl: server.url.href };
      expect(await discoverConnectionModels(args, "test")).toMatchObject({
        ok: true,
        models: [{ id: "model" }],
      });
      expect(await testConnection(args, "test", "model")).toEqual({
        ok: false,
        reason: "unsupported",
        status: 404,
      });
      expect(methods).toEqual(["GET /v1/models", "POST /v1/responses", "GET /v1/chat/completions"]);
    } finally {
      server.stop(true);
    }
  });
});
