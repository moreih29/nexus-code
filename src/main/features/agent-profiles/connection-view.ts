import type { AgentProfile } from "../../../shared/agent-profiles/profiles";

export interface ProfileModelView {
  id: string;
  label?: string;
  contextWindow?: number;
  reasoning?: string;
}

export interface ProfileConnectionView {
  method: string;
  preset?: string;
  baseUrl?: string;
  baseUrlRedacted?: boolean;
  auth?: string;
  models?: ProfileModelView[];
  defaultModel?: string;
  lightModel?: string;
  contextWindow?: number;
  advanced?: {
    timeoutMs?: number;
    maxOutputTokens?: number;
    disableExperimentalBetas?: boolean;
    retries?: number;
    streamIdleTimeoutMs?: number;
    headers?: string[];
    query?: string[];
  };
}

export const MAX_VIEW_PAIRS = 64;

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function names(pairs: Record<string, string> | undefined): string[] | undefined {
  const keys = Object.keys(pairs ?? {}).slice(0, MAX_VIEW_PAIRS);
  return keys.length ? keys : undefined;
}

export const REDACTED_VALUE = "***";

export function redactedBaseUrl(address: string): { baseUrl?: string; redacted: boolean } {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { redacted: true };
  }
  if (!url.username && !url.password && !url.search && !url.hash) {
    return { baseUrl: address, redacted: false };
  }
  const query = [...new Set(url.searchParams.keys())].slice(0, MAX_VIEW_PAIRS);
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  for (const name of query) url.searchParams.append(name, REDACTED_VALUE);
  return { baseUrl: url.href, redacted: true };
}

export function redactedConnectionView(view: ProfileConnectionView): ProfileConnectionView {
  if (view.baseUrl === undefined) return view;
  const { baseUrl, redacted } = redactedBaseUrl(view.baseUrl);
  return redacted ? defined({ ...view, baseUrl, baseUrlRedacted: true }) : view;
}

export function profileConnectionView(
  profile: Pick<AgentProfile, "agent" | "connection">,
): ProfileConnectionView {
  const { connection } = profile;
  if (connection?.method !== "custom") return { method: connection?.method ?? "account" };
  const advanced = connection.advanced
    ? defined({
        timeoutMs: connection.advanced.timeoutMs,
        maxOutputTokens: connection.advanced.maxOutputTokens,
        disableExperimentalBetas: connection.advanced.disableExperimentalBetas,
        retries: connection.advanced.retries,
        streamIdleTimeoutMs: connection.advanced.streamIdleTimeoutMs,
        headers: names(connection.advanced.headers),
        query: names(connection.advanced.query),
      })
    : undefined;
  return redactedConnectionView(
    defined({
      method: "custom",
      preset: connection.preset,
      baseUrl: connection.baseUrl,
      auth: profile.agent === "codex" ? "bearer" : (connection.auth ?? "bearer"),
      models: connection.models.map(({ id, label, contextWindow, reasoning }) =>
        defined({ id, label: label || undefined, contextWindow, reasoning }),
      ),
      defaultModel: connection.defaultModel,
      lightModel: connection.lightModel,
      contextWindow: connection.contextWindow,
      advanced: advanced && Object.keys(advanced).length ? advanced : undefined,
    }),
  );
}
