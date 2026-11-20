import {
  type ConnectionFailure,
  type ConnectionModelsResult,
  type ConnectionProbe,
  type ConnectionTestResult,
  type DiscoveredModel,
  DiscoveredModelSchema,
  normalizeConnectionUrl,
} from "../../../shared/agent-profiles/connection";

export function connectionEndpoint(probe: ConnectionProbe, route: string): URL {
  const base = normalizeConnectionUrl(probe.agent, probe.baseUrl);
  const url = new URL(base + (probe.agent === "claude" ? "/v1/" : "/") + route);
  if (probe.agent === "codex" && probe.query) {
    url.search = new URLSearchParams(probe.query).toString();
  }
  return url;
}

export function classifyConnectionError(
  status: number,
  body: string,
  operation: "list" | "test",
  codex: boolean,
): ConnectionFailure {
  if (status === 401 || status === 403) return { ok: false, reason: "auth", status };
  const missingModel =
    /model[_ -]not[_ -]found|unknown model|invalid model|model[^{}\n]{0,160}(?:not found|does not exist|not supported)/i.test(
      body,
    );
  if (operation === "test" && missingModel) return { ok: false, reason: "model", status };
  if (
    operation === "test" &&
    codex &&
    ([405, 501].includes(status) ||
      /responses api[^{}\n]{0,80}(?:not (?:found|supported)|unsupported)|only supports chat completions/i.test(
        body,
      ))
  ) {
    return { ok: false, reason: "unsupported", status };
  }
  return {
    ok: false,
    reason: operation === "test" && status === 404 ? (codex ? "address" : "model") : "response",
    status,
  };
}

function headersFor(probe: ConnectionProbe, key: string | undefined): Headers {
  const headers = new Headers(probe.headers);
  if (probe.agent === "claude") headers.set("anthropic-version", "2023-06-01");
  if (key) {
    if (probe.agent === "claude" && probe.auth === "x-api-key") headers.set("x-api-key", key);
    else headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function discoveredModels(payload: unknown, tags?: unknown): DiscoveredModel[] | null {
  const data = record(payload).data;
  if (!Array.isArray(data)) return null;
  const tagModels = record(tags).models;
  const sizes = new Map<unknown, unknown>(
    Array.isArray(tagModels)
      ? tagModels.map((tag) => [record(tag).name ?? record(tag).model, record(tag).size])
      : [],
  );
  const results = new Map<string, DiscoveredModel>();
  for (const item of data) {
    const { id, display_name, name, meta, context_length } = record(item);
    const size = sizes.get(id);
    const context = record(meta).n_ctx ?? context_length;
    const parsed = DiscoveredModelSchema.safeParse({
      id,
      label:
        typeof display_name === "string"
          ? display_name.slice(0, 128)
          : typeof name === "string"
            ? name.slice(0, 128)
            : undefined,
      contextWindow: typeof context === "number" && context > 0 ? context : undefined,
      bytes: typeof size === "number" && size >= 0 ? size : undefined,
    });
    if (parsed.success && !results.has(parsed.data.id)) results.set(parsed.data.id, parsed.data);
  }
  return [...results.values()];
}

export async function discoverConnectionModels(
  probe: ConnectionProbe,
  key: string | undefined,
): Promise<ConnectionModelsResult> {
  let endpoint: URL;
  let headers: Headers;
  try {
    endpoint = connectionEndpoint(probe, "models");
    headers = headersFor(probe, key);
  } catch {
    return { ok: false, reason: "address" };
  }
  const signal = AbortSignal.timeout(3000);
  try {
    const response = await fetch(endpoint, { headers, signal, redirect: "error" });
    if (!response.ok)
      return classifyConnectionError(response.status, "", "list", probe.agent === "codex");
    const payload = await response.json();
    let tags: unknown;
    if (probe.preset === "ollama") {
      tags = await fetch(new URL("/api/tags", endpoint), { headers, signal, redirect: "error" })
        .then((res) => (res.ok ? res.json() : undefined))
        .catch(() => undefined);
    }
    const models = discoveredModels(payload, tags);
    return models ? { ok: true, models } : { ok: false, reason: "response" };
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? "response" : "network" };
  }
}

export async function testConnection(
  probe: ConnectionProbe,
  key: string | undefined,
  model: string,
): Promise<ConnectionTestResult> {
  const codex = probe.agent === "codex";
  let endpoint: URL;
  let headers: Headers;
  try {
    endpoint = connectionEndpoint(probe, codex ? "responses" : "messages");
    headers = headersFor(probe, key);
    headers.set("content-type", "application/json");
  } catch {
    return { ok: false, reason: "address" };
  }
  const started = performance.now();
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal,
      body: JSON.stringify(
        codex
          ? { model, input: "Reply with OK.", max_output_tokens: 16, store: false }
          : { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 },
      ),
    });
    if (!response.ok) {
      const error = classifyConnectionError(response.status, await response.text(), "test", codex);
      if (codex && response.status === 404 && error.reason === "address") {
        // A GET can identify the sibling route without making a second inference request.
        const chat = await fetch(connectionEndpoint(probe, "chat/completions"), {
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
          redirect: "error",
        }).catch(() => undefined);
        if (chat && (chat.ok || chat.status === 405 || chat.status === 400)) {
          return { ...error, reason: "unsupported" };
        }
      }
      return error;
    }
    const body = record(await response.json());
    const valid = codex ? Array.isArray(body.output) : Array.isArray(body.content);
    return valid
      ? { ok: true, ms: Math.round(performance.now() - started) }
      : { ok: false, reason: "response", status: response.status };
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? "response" : "network" };
  }
}
