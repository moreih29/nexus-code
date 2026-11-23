import { isDeepStrictEqual } from "node:util";
import {
  API_KEY_CONNECTION_URL,
  type ConnectionModel,
  type CustomConnection,
  claudeReasoningModelIdSupported,
  connectionReasoningLevels,
  normalizeConnectionUrl,
} from "../../../shared/agent-profiles/connection";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import codexInstructions from "./codex-instructions";

const CODEX_PROVIDER = "nexus_profile";
const CODEX_PROVIDER_KEY = "NEXUS_PROFILE_CODEX_API_KEY";

function launchConnection(profile: AgentProfile | null): unknown {
  const connection = profile?.connection;
  if (connection?.method !== "custom") return connection?.method ?? "account";
  const { preset, advanced, ...options } = connection;
  return JSON.parse(
    JSON.stringify({
      ...options,
      auth: profile?.agent === "claude" ? (connection.auth ?? "bearer") : undefined,
      lmStudio: profile?.agent === "claude" && preset === "lmstudio",
      advanced:
        advanced && Object.values(advanced).some((value) => value !== undefined)
          ? advanced
          : undefined,
    }),
  );
}

export function sameLaunchConnection(before: AgentProfile | null, after: AgentProfile): boolean {
  return isDeepStrictEqual(launchConnection(before), launchConnection(after));
}

const NO_CLAUDE_EFFORT = "-effort,-xhigh_effort,-max_effort";

function claudeReasoningCapabilities(reasoning: ConnectionModel["reasoning"]): string {
  switch (reasoning) {
    case "max":
      return "effort,xhigh_effort,max_effort";
    case "high":
      return "effort,-xhigh_effort,-max_effort";
    case "xhigh":
      return "effort,xhigh_effort,-max_effort";
    default:
      return NO_CLAUDE_EFFORT;
  }
}

function claudeModelCapabilities(models: readonly ConnectionModel[]): string | undefined {
  const rules: string[] = [];
  for (const model of models) {
    if (!model.reasoning || !claudeReasoningModelIdSupported(model.id)) continue;
    const id = model.id.replace(/\[1m\]$/i, "").toLowerCase();
    rules.push(`${id}=${claudeReasoningCapabilities(model.reasoning)}`);
  }
  return rules.length ? rules.join(";") : undefined;
}

export function claudeConnectionEnv(
  connection: AgentProfile["connection"],
  key: string | undefined,
): Record<string, string> {
  if (!connection || connection.method === "account") return {};
  const routing = {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    CLAUDE_CODE_USE_MANTLE: "",
  };
  if (connection.method === "api-key") {
    return {
      ...routing,
      ANTHROPIC_BASE_URL: API_KEY_CONNECTION_URL.claude,
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: key ?? "",
    };
  }
  const { advanced, contextWindow, defaultModel, lightModel = defaultModel, models } = connection;
  const token = key ?? (connection.preset === "lmstudio" ? "lmstudio" : "nexus-local");
  const env: Record<string, string> = {
    ...routing,
    ANTHROPIC_BASE_URL: normalizeConnectionUrl("claude", connection.baseUrl),
    ANTHROPIC_AUTH_TOKEN: connection.auth === "x-api-key" ? "" : token,
    ANTHROPIC_API_KEY: connection.auth === "x-api-key" ? token : "",
    ANTHROPIC_MODEL: defaultModel,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
  };
  const capabilities = claudeModelCapabilities(models);
  if (capabilities) env.CLAUDE_CODE_MODEL_CAPABILITIES = capabilities;
  for (const [tier, id] of [
    ["OPUS", defaultModel],
    ["SONNET", defaultModel],
    ["FABLE", defaultModel],
    ["HAIKU", lightModel],
  ] as const) {
    const variable = `ANTHROPIC_DEFAULT_${tier}_MODEL`;
    env[variable] = id;
    env[`${variable}_NAME`] = models.find((model) => model.id === id)?.label || id;
  }
  if (contextWindow !== undefined) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  if (advanced?.headers) {
    env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(advanced.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  }
  if (advanced?.timeoutMs !== undefined) env.API_TIMEOUT_MS = String(advanced.timeoutMs);
  if (advanced?.maxOutputTokens !== undefined) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(advanced.maxOutputTokens);
  }
  if (advanced?.disableExperimentalBetas !== undefined) {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = advanced.disableExperimentalBetas ? "1" : "0";
  }
  if (connection.preset === "lmstudio") env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  return env;
}

export function claudeModelPicker(connection: AgentProfile["connection"]) {
  if (connection?.method !== "custom") return undefined;
  return {
    replaceBuiltInOptions: true,
    options: connection.models.map(({ id, label }) => ({ model: id, label: label || id })),
  };
}

export function codexConnectionEnv(
  connection: AgentProfile["connection"],
  key: string | undefined,
): Record<string, string> {
  if (!connection || connection.method === "account") return {};
  return { [CODEX_PROVIDER_KEY]: key ?? "", CODEX_API_KEY: "", OPENAI_API_KEY: "" };
}

function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\x7f", "\\u007F");
}

function tomlTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

export function codexConnectionArgs(
  connection: AgentProfile["connection"],
  key: string | undefined,
  catalogPath?: string,
): string[] {
  if (connection?.method === "api-key") {
    return [
      "-c",
      `model_provider=${tomlString(CODEX_PROVIDER)}`,
      "-c",
      `model_providers.${CODEX_PROVIDER}={ name = "OpenAI API", base_url = "${API_KEY_CONNECTION_URL.codex}", env_key = "${CODEX_PROVIDER_KEY}", wire_api = "responses", requires_openai_auth = false }`,
    ];
  }
  if (connection?.method !== "custom") return [];
  if (!catalogPath) throw new Error("Codex model catalog is missing");
  const { advanced } = connection;
  const values: Record<string, string> = {
    name: tomlString("Profile API"),
    base_url: tomlString(normalizeConnectionUrl("codex", connection.baseUrl)),
    wire_api: tomlString("responses"),
    requires_openai_auth: "false",
  };
  if (key) values.env_key = tomlString(CODEX_PROVIDER_KEY);
  if (advanced?.headers) values.http_headers = tomlTable(advanced.headers);
  if (advanced?.query) values.query_params = tomlTable(advanced.query);
  if (advanced?.retries !== undefined) {
    values.request_max_retries = String(advanced.retries);
    values.stream_max_retries = String(advanced.retries);
  }
  if (advanced?.streamIdleTimeoutMs !== undefined) {
    values.stream_idle_timeout_ms = String(advanced.streamIdleTimeoutMs);
  }
  return [
    "-c",
    `model=${tomlString(connection.defaultModel)}`,
    "-c",
    `model_provider=${tomlString(CODEX_PROVIDER)}`,
    "-c",
    `model_providers.${CODEX_PROVIDER}={ ${Object.entries(values)
      .map(([name, value]) => `${name} = ${value}`)
      .join(", ")} }`,
    "-c",
    `model_catalog_json=${tomlString(catalogPath)}`,
    "-c",
    'web_search="disabled"',
  ];
}

export function codexConnectionCatalog(connection: CustomConnection) {
  const ordered = [
    ...connection.models.filter(({ id }) => id === connection.defaultModel),
    ...connection.models.filter(({ id }) => id !== connection.defaultModel),
  ];
  return {
    models: ordered.map((model, priority) => {
      const context = model.contextWindow ?? 131_072;
      const efforts = connectionReasoningLevels(model.reasoning);
      return {
        slug: model.id,
        display_name: model.label || model.id,
        base_instructions: codexInstructions,
        context_window: context,
        max_context_window: context,
        default_reasoning_level: efforts.length ? "low" : null,
        supported_reasoning_levels: efforts.map((effort) => ({ effort, description: "" })),
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority,
        support_verbosity: false,
        supports_reasoning_summaries: false,
        supports_reasoning_summary_parameter: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        experimental_supported_tools: [],
      };
    }),
  };
}
