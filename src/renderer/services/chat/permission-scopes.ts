// What "always allow" on a permission request would add, in words: the
// rules, mode, folders or Codex session scope the program suggests, one
// at a time. The card offers them; another device names them by index.

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One rule or mode "always allow" would add. */
export interface Scope {
  readonly label: string;
  /** The suggestion as the program gave it, to give back. */
  readonly suggestion: unknown;
}

/** What "always allow" would add, one suggestion at a time, in words; those it cannot word left out. */
export function scopesOf(suggestions: readonly unknown[], t: Translate): Scope[] {
  const scopes: Scope[] = [];
  for (const raw of suggestions) {
    const label = describeSuggestion(raw, t);
    if (label) scopes.push({ label, suggestion: raw });
  }
  return scopes;
}

function describeSuggestion(raw: unknown, t: Translate): string {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return "";
  if (s.type === "addRules" && Array.isArray(s.rules)) {
    return (s.rules as Record<string, unknown>[])
      .map((rule) => {
        const name = String(rule.toolName ?? "");
        return rule.ruleContent ? `${name}(${String(rule.ruleContent)})` : name;
      })
      .join(", ");
  }
  if (s.type === "setMode" && typeof s.mode === "string") {
    return t("chat.permission.suggest_mode", { mode: t(`chat.mode.${s.mode}`) });
  }
  if (s.type === "session") {
    // Codex: the same call, allowed again without asking until the program ends.
    return t("chat.permission.suggest_session");
  }
  if (s.type === "addDirectories" && Array.isArray(s.directories)) {
    return t("chat.permission.suggest_dirs", { dirs: (s.directories as string[]).join(", ") });
  }
  return "";
}
