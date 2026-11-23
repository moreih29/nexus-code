type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface Scope {
  readonly label: string;
  readonly suggestion: unknown;
}

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
  if (s.type === "remote" && typeof s.label === "string") return s.label;
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
    return t("chat.permission.suggest_session");
  }
  if (s.type === "addDirectories" && Array.isArray(s.directories)) {
    return t("chat.permission.suggest_dirs", { dirs: (s.directories as string[]).join(", ") });
  }
  return "";
}
