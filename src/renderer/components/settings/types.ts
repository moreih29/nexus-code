// src/renderer/components/settings/types.ts — Settings dialog shared types.

export interface SettingsNavItem {
  /** Unique identifier for this nav item — used as the activeId value. */
  id: string;
  /** Display label shown in the nav sidebar. */
  label: string;
  /**
   * The page this one belongs under, by its id: listed indented beneath it,
   * and named before it in the panel's title. The parent must come first.
   */
  parent?: string;
  /** Kept apart at the foot of the list: a page that is not a setting (About). */
  footer?: boolean;
  /**
   * Tokens used by the search box to match this item beyond `label`.
   * E.g. an "Appearance" item might add ["theme", "opacity"] so typing "opa"
   * still surfaces it.
   */
  keywords?: string[];
  /**
   * When true, the nav row shows a small dot indicating the panel has
   * uncommitted / changed-from-default values in the current session.
   * Caller is responsible for computing this per-panel.
   */
  dirty?: boolean;
}

/** What finds the Claude, Codex and Profiles by workspace pages in the search box. */
export const PROFILE_KEYWORDS: string[] = [
  "profile",
  "account",
  "login",
  "sign in",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "프로필",
  "계정",
  "로그인",
];
