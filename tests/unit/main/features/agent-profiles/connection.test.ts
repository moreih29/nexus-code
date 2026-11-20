import { describe, expect, test } from "bun:test";
import { ConnectionKeys } from "../../../../../src/main/features/agent-profiles/connection-keys";
import {
  claudeConnectionEnv,
  claudeModelPicker,
  codexConnectionArgs,
  codexConnectionCatalog,
  codexConnectionEnv,
} from "../../../../../src/main/features/agent-profiles/connection-launch";
import {
  classifyConnectionError,
  connectionEndpoint,
  discoverConnectionModels,
  discoveredModels,
  testConnection,
} from "../../../../../src/main/features/agent-profiles/connection-probe";
import { keptInMemory } from "../../../../../src/main/features/remote/sealed-file";
import {
  type CustomConnection,
  connectionDefaultModel,
  connectionKeyTarget,
  normalizeConnectionUrl,
} from "../../../../../src/shared/agent-profiles/connection";
import { mergeAgentEnv } from "../../../../../src/shared/agent-profiles/env";
import {
  type AgentProfile,
  AgentProfileSchema,
  AgentProfilesSchema,
  profilesOf,
} from "../../../../../src/shared/agent-profiles/profiles";

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
  });

  test("keeps keys bound to their endpoint, reports only a suffix, and clears removed profiles", async () => {
    const keys = new ConnectionKeys(keptInMemory(), false);
    const target = connectionKeyTarget("claude", connection);
    await keys.saveProfile(profile, "test-test-1234", () => {});
    expect(await keys.status(profile)).toEqual({ present: true, last4: "1234", persistent: false });
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
    expect((await keys.status(profile)).last4).toBeUndefined();
    await keys.prune(() => new Set());
    expect(await keys.get(profile.id, target)).toBeUndefined();
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
