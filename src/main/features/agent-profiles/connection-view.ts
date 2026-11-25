import type { ProfileConnectionView } from "../../../../packages/remote-protocol/src";
import { type AgentProfile, profilesOf } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { ProfileConnections } from "./connection-save";

export type { ProfileConnectionView };
export type ProfileModelView = NonNullable<ProfileConnectionView["models"]>[number];

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

export interface ProfileConnectionFields {
  color?: string;
  connection?: ProfileConnectionView;
  hasKey?: boolean;
}

export function withProfileConnections<T extends { id: string; agent: ChatAgent }>(
  connections: Pick<ProfileConnections, "config" | "keyPresent">,
  rows: readonly T[],
): Promise<(T & ProfileConnectionFields)[]> {
  const config = connections.config();
  return Promise.all(
    rows.map(async (row) => {
      const profile = profilesOf(config, row.agent).find(({ id }) => id === row.id);
      if (!profile) return row;
      const hasKey = await connections.keyPresent(profile).catch(() => undefined);
      return {
        ...row,
        color: profile.color,
        connection: profileConnectionView(profile),
        ...(hasKey !== undefined ? { hasKey } : {}),
      };
    }),
  );
}

export function profilesNamed<T extends { id: string; name: string }>(
  rows: readonly T[],
  selector: string,
): T[] {
  const exact = rows.filter(({ id }) => id === selector);
  if (exact.length) return exact;
  const wanted = selector.trim().toLowerCase();
  return rows.filter(
    ({ id, name }) => id.toLowerCase() === wanted || name.trim().toLowerCase() === wanted,
  );
}
