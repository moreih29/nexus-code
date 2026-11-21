import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";
import type { AgentProfile } from "./profiles";

const limit = z.number().int().positive().max(2_147_483_647);
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const fields = z.record(z.string().min(1).max(128), z.string().max(4096));
export const CONNECTION_METHODS = ["account", "api-key", "custom"] as const;
export const API_KEY_CONNECTION_URL: Record<ChatAgent, string> = {
  claude: "https://api.anthropic.com",
  codex: "https://api.openai.com/v1",
};
export const CONNECTION_AUTH = ["bearer", "x-api-key"] as const;
export const CONNECTION_REASONING = ["none", "high", "xhigh", "max"] as const;
export const LOCAL_CONNECTION_PRESETS = ["ollama", "lmstudio", "strata"] as const;
export const CONNECTION_PRESETS = [
  "openrouter",
  "zai",
  "deepseek",
  "kimi",
  "minimax",
  "litellm",
  ...LOCAL_CONNECTION_PRESETS,
] as const;

export const ConnectionModelSchema = z.object({
  id: modelId,
  label: z.string().trim().max(128).optional(),
  contextWindow: limit.optional(),
  reasoning: z.enum(CONNECTION_REASONING).optional(),
});
export type ConnectionModel = z.infer<typeof ConnectionModelSchema>;

/** Whether Claude Code's capability-rule grammar can name this model exactly. */
export function claudeReasoningModelIdSupported(id: string): boolean {
  const normalized = id.replace(/\[1m\]$/i, "");
  return !/[;,=]/.test(normalized) && !normalized.endsWith("*");
}

/** The effort levels a custom model offers, from the conservative default to its configured maximum. */
export function connectionReasoningLevels(reasoning: ConnectionModel["reasoning"]): string[] {
  switch (reasoning) {
    case "max":
      return ["low", "medium", "high", "xhigh", "max"];
    case "xhigh":
      return ["low", "medium", "high", "xhigh"];
    case "high":
      return ["low", "medium", "high"];
    default:
      return [];
  }
}

const profileConnectionSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("account") }),
  z.object({ method: z.literal("api-key") }),
  z.object({
    method: z.literal("custom"),
    baseUrl: z.string().trim().min(1).max(2048),
    auth: z.enum(CONNECTION_AUTH).optional(),
    preset: z.enum(CONNECTION_PRESETS).optional(),
    models: z.array(ConnectionModelSchema).min(1).max(128),
    defaultModel: modelId,
    lightModel: modelId.optional(),
    contextWindow: limit.optional(),
    advanced: z
      .object({
        headers: fields.optional(),
        timeoutMs: limit.optional(),
        maxOutputTokens: limit.optional(),
        disableExperimentalBetas: z.boolean().optional(),
        query: fields.optional(),
        retries: z.number().int().min(0).max(100).optional(),
        streamIdleTimeoutMs: limit.optional(),
      })
      .optional(),
  }),
]);
export type ProfileConnection = z.infer<typeof profileConnectionSchema>;
export const ProfileConnectionSchema: z.ZodType<ProfileConnection> = profileConnectionSchema;
export type CustomConnection = Extract<ProfileConnection, { method: "custom" }>;
export type ConnectionPreset = (typeof CONNECTION_PRESETS)[number];

export function connectionDefaultModel(
  profile: Pick<AgentProfile, "connection">,
): string | undefined {
  return profile.connection?.method === "custom" ? profile.connection.defaultModel : undefined;
}

/** A saved key follows its provider and the exact endpoint and auth method it was entered for. */
export function connectionKeyTarget(
  agent: ChatAgent,
  connection:
    | { method: "account" | "api-key" }
    | Pick<CustomConnection, "method" | "baseUrl" | "auth">
    | undefined,
) {
  switch (connection?.method) {
    case "api-key":
      return agent;
    case "custom":
      return JSON.stringify([
        agent,
        normalizeConnectionUrl(agent, connection.baseUrl),
        agent === "claude" ? (connection.auth ?? "bearer") : "bearer",
      ]);
    default:
      return undefined;
  }
}

export function isLocalConnectionPreset(
  preset: ConnectionPreset | undefined,
): preset is (typeof LOCAL_CONNECTION_PRESETS)[number] {
  return LOCAL_CONNECTION_PRESETS.some((value) => value === preset);
}

export function connectionPresetsFor(agent: ChatAgent): readonly ConnectionPreset[] {
  return agent === "claude"
    ? CONNECTION_PRESETS
    : CONNECTION_PRESETS.filter((value) => value === "litellm" || isLocalConnectionPreset(value));
}

export function connectionPreset(agent: ChatAgent, preset: ConnectionPreset) {
  const local: Record<(typeof LOCAL_CONNECTION_PRESETS)[number], string> = {
    ollama: "http://localhost:11434",
    lmstudio: "http://localhost:1234",
    strata: "http://127.0.0.1:8080",
  };
  if (isLocalConnectionPreset(preset)) {
    const base = local[preset];
    return { baseUrl: agent === "codex" ? `${base}/v1` : base, auth: "bearer" as const };
  }
  const urls = {
    openrouter: "https://openrouter.ai/api",
    zai: "https://api.z.ai/api/anthropic",
    deepseek: "https://api.deepseek.com/anthropic",
    kimi: "https://api.kimi.ai/coding",
    minimax: "https://api.minimax.io/anthropic",
    litellm: agent === "codex" ? "http://localhost:4000/v1" : "http://localhost:4000",
  } as const;
  return {
    baseUrl: urls[preset],
    auth: preset === "kimi" ? ("x-api-key" as const) : ("bearer" as const),
  };
}

/** Keep gateway path prefixes and reject credentials, query, and fragments in the base URL. */
export function normalizeConnectionUrl(agent: ChatAgent, address: string): string {
  const url = new URL(address.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid API address");
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + (agent === "claude" ? path.replace(/(?:\/v1)+$/, "") : path || "/v1");
}

export const ConnectionKeyChangeSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  z.null(),
]);
export type ConnectionKeyChange = z.infer<typeof ConnectionKeyChangeSchema>;

export const ConnectionKeyStatusSchema = z.object({
  present: z.boolean(),
  last4: z.string().optional(),
  persistent: z.boolean(),
});
export type ConnectionKeyStatus = z.infer<typeof ConnectionKeyStatusSchema>;

export const ConnectionProbeSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  baseUrl: z.string().max(2048),
  auth: z.enum(CONNECTION_AUTH).optional(),
  preset: z.enum(CONNECTION_PRESETS).optional(),
  profileId: z.string().max(64).optional(),
  key: ConnectionKeyChangeSchema.optional(),
  headers: fields.optional(),
  query: fields.optional(),
});
export type ConnectionProbe = z.infer<typeof ConnectionProbeSchema>;

export const DiscoveredModelSchema = ConnectionModelSchema.extend({
  bytes: z.number().nonnegative().optional(),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;
export const ConnectionFailureSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(["auth", "model", "network", "address", "unsupported", "response"]),
  status: z.number().int().optional(),
});
export type ConnectionFailure = z.infer<typeof ConnectionFailureSchema>;
const connectionModelsResultSchema = z.union([
  z.object({ ok: z.literal(true), models: z.array(DiscoveredModelSchema) }),
  ConnectionFailureSchema,
]);
export type ConnectionModelsResult = z.infer<typeof connectionModelsResultSchema>;
export const ConnectionModelsResultSchema: z.ZodType<ConnectionModelsResult> =
  connectionModelsResultSchema;
const connectionTestResultSchema = z.union([
  z.object({ ok: z.literal(true), ms: z.number().nonnegative() }),
  ConnectionFailureSchema,
]);
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export const ConnectionTestResultSchema: z.ZodType<ConnectionTestResult> =
  connectionTestResultSchema;
