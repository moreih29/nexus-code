import { code, type Words } from "../app-commands";

export function memoryFilesOf(usage: unknown): { path: string; type: string }[] {
  const files = (usage as { memoryFiles?: unknown } | null)?.memoryFiles;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    const { path, type } = (file ?? {}) as { path?: unknown; type?: unknown };
    return typeof path === "string" && path
      ? [{ path, type: typeof type === "string" ? type : "" }]
      : [];
  });
}

interface PermissionRule {
  behavior: string;
  source: string;
  rule: string;
  notInEffect?: boolean;
}

export function permissionsOf(body: unknown): {
  rules: PermissionRule[];
  directories: { path: string; source: string }[];
  cwd: string;
} {
  const state = ((body as { state?: unknown } | null)?.state ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(state.rules)
    ? state.rules.flatMap((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return typeof r.rule === "string" && typeof r.behavior === "string"
          ? [
              {
                behavior: r.behavior,
                source: typeof r.source === "string" ? r.source : "",
                rule: r.rule,
                notInEffect: r.notInEffect === true,
              },
            ]
          : [];
      })
    : [];
  const directories = Array.isArray(state.workspaceDirectories)
    ? state.workspaceDirectories.flatMap((raw) => {
        const d = (raw ?? {}) as Record<string, unknown>;
        return typeof d.path === "string"
          ? [{ path: d.path, source: typeof d.source === "string" ? d.source : "" }]
          : [];
      })
    : [];
  return {
    rules,
    directories,
    cwd: typeof state.originalCwd === "string" ? state.originalCwd : "",
  };
}

const SOURCES = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
]);

function sourceLabel(source: string, t: Words): string {
  return SOURCES.has(source) ? t(`chat.commands.source.${source}`) : source;
}

export function permissionsMarkdown(
  state: ReturnType<typeof permissionsOf>,
  t: Words,
  added: readonly string[] = [],
): string {
  const parts: string[] = [];
  for (const behavior of ["allow", "ask", "deny"]) {
    const rules = state.rules.filter((r) => r.behavior === behavior);
    if (rules.length === 0) continue;
    const lines = rules.map(
      (r) =>
        `- ${code(r.rule)} · ${sourceLabel(r.source, t)}${r.notInEffect ? ` · ${t("chat.commands.not_in_effect")}` : ""}`,
    );
    parts.push(`**${t(`chat.commands.behavior.${behavior}`)}**\n\n${lines.join("\n")}`);
  }
  if (parts.length === 0) parts.push(t("chat.commands.no_rules"));
  if (state.directories.length > 0) {
    const lines = state.directories.map(
      (d) =>
        `- ${code(d.path)} · ${added.includes(d.path) ? t("chat.commands.source.added") : sourceLabel(d.source, t)}`,
    );
    parts.push(`**${t("chat.commands.directories")}**\n\n${lines.join("\n")}`);
  }
  parts.push(t("chat.commands.permissions_edit"));
  return parts.join("\n\n");
}

export function permissionFiles(state: ReturnType<typeof permissionsOf>): string[] {
  if (!state.cwd) return [];
  const root = state.cwd.replace(/\/+$/, "");
  const files: string[] = [];
  if (state.rules.some((r) => r.source === "projectSettings"))
    files.push(`${root}/.claude/settings.json`);
  if (state.rules.some((r) => r.source === "localSettings")) {
    files.push(`${root}/.claude/settings.local.json`);
  }
  return files;
}

export function hooksMarkdown(body: unknown, t: Words): string {
  const listing = (body ?? {}) as { events?: unknown; hooks?: unknown };
  const hooks = Array.isArray(listing.hooks) ? (listing.hooks as Record<string, unknown>[]) : [];
  if (hooks.length === 0) return t("chat.commands.no_hooks");
  const summaries = new Map<string, string>();
  if (Array.isArray(listing.events)) {
    for (const raw of listing.events as Record<string, unknown>[]) {
      if (typeof raw?.name === "string" && typeof raw.summary === "string") {
        summaries.set(raw.name, raw.summary);
      }
    }
  }
  const byEvent = new Map<string, string[]>();
  for (const hook of hooks) {
    const event = typeof hook.event === "string" ? hook.event : "";
    const text = typeof hook.displayText === "string" ? hook.displayText : "";
    const matcher =
      typeof hook.matcher === "string" && hook.matcher ? `${code(hook.matcher)} · ` : "";
    const type = typeof hook.type === "string" ? hook.type : "";
    const source = typeof hook.sourceLabel === "string" ? hook.sourceLabel : "";
    const line = `- ${matcher}${type ? `${type} · ` : ""}${code(text)}${source ? ` · ${source}` : ""}`;
    byEvent.set(event, [...(byEvent.get(event) ?? []), line]);
  }
  return [...byEvent]
    .map(([event, lines]) => {
      const summary = summaries.get(event);
      return `**${event}**${summary ? ` — ${summary}` : ""}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export function sandboxOn(body: unknown): boolean {
  const effective = (body as { effective?: { sandbox?: { enabled?: unknown } } } | null)?.effective;
  return effective?.sandbox?.enabled === true;
}

export function planOf(body: unknown): { content: string; path?: string } | null {
  const plan = (body ?? {}) as { exists?: unknown; content?: unknown; path?: unknown };
  if (plan.exists !== true || typeof plan.content !== "string") return null;
  return {
    content: plan.content,
    ...(typeof plan.path === "string" && plan.path ? { path: plan.path } : {}),
  };
}

export interface BackgroundSession {
  id: string;
  sessionId?: string;
  name: string;
  status: string;
  startedAt?: number;
}

export function backgroundSessionsOf(stdout: string): BackgroundSession[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((raw): BackgroundSession[] => {
      const entry = raw as Record<string, unknown> | null;
      if (entry?.kind !== "background" || typeof entry.id !== "string") return [];
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(entry.id)) return [];
      const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return [
        {
          id: entry.id,
          sessionId: text(entry.sessionId),
          name: text(entry.name) ?? entry.id,
          status:
            text(entry.state) === "stopped"
              ? "stopped"
              : (text(entry.status) ?? text(entry.state) ?? ""),
          startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
        },
      ];
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function backgroundIdOf(stdout: string): string | null {
  return /backgrounded\s*·\s*([0-9a-f]{8})\b/.exec(stdout)?.[1] ?? null;
}

export type PluginAction = "install" | "enable" | "disable" | "update" | "uninstall";

export interface PluginInfo {
  id: string;
  version?: string;
  scope: string;
  enabled: boolean;
}

export function pluginsOf(stdout: string): PluginInfo[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): PluginInfo[] => {
    const plugin = raw as Record<string, unknown> | null;
    if (typeof plugin?.id !== "string" || !plugin.id) return [];
    return [
      {
        id: plugin.id,
        version: typeof plugin.version === "string" ? plugin.version : undefined,
        scope: typeof plugin.scope === "string" ? plugin.scope : "",
        enabled: plugin.enabled === true,
      },
    ];
  });
}

export function pluginResultOf(run: { code: number; stdout: string; stderr: string }): {
  ok: boolean;
  message: string;
} {
  for (const line of run.stdout.split("\n")) {
    try {
      const result = JSON.parse(line) as { outcome?: unknown; message?: unknown };
      if (typeof result?.outcome === "string") {
        return {
          ok: result.outcome === "ok",
          message: typeof result.message === "string" ? result.message : result.outcome,
        };
      }
    } catch {}
  }
  return {
    ok: run.code === 0,
    message: (run.code === 0 ? run.stdout : run.stderr || run.stdout).trim(),
  };
}
