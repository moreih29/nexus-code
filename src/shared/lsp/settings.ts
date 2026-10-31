/**
 * Language server settings: the master switch, each language's own, and the
 * languages a workspace turned off. Main and the renderer read them through
 * the same helpers, so both agree on whether a server should run.
 */

import { z } from "zod";
import { LSP_MAX_ACTIVE_WORKSPACES } from "../util/timing-constants";
import { BUILTIN_LSP_PRESETS, type LspServerSpec } from "./config";

export const LspLanguageSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** TypeScript: one tsserver per workspace and no typings installer. */
  lowMemory: z.boolean().optional(),
  /**
   * A server the app does not bundle: where it is on the workspace's host,
   * "~" for the user's home. Searched for when empty or wrong.
   */
  path: z.string().max(4096).optional(),
});
export type LspLanguageSettings = z.infer<typeof LspLanguageSettingsSchema>;

export const LSP_MAX_ACTIVE_WORKSPACES_LIMIT = 16;

export const LspSettingsSchema = z.object({
  enabled: z.boolean(),
  languages: z.record(z.string(), LspLanguageSettingsSchema),
  maxActiveWorkspaces: z.number().int().min(1).max(LSP_MAX_ACTIVE_WORKSPACES_LIMIT),
  /** workspaceId → languages turned off in that workspace. */
  disabledByWorkspace: z.record(z.string(), z.array(z.string())),
});
export type LspSettings = z.infer<typeof LspSettingsSchema>;

/** The app state fields the settings live in. */
export interface LspSettingsState {
  lspEnabled?: boolean;
  lspLanguages?: Record<string, LspLanguageSettings>;
  lspMaxActiveWorkspaces?: number;
  lspDisabledLanguagesByWorkspace?: Record<string, string[]>;
}

export function lspSettingsFromState(state: LspSettingsState): LspSettings {
  return {
    enabled: state.lspEnabled === true,
    languages: state.lspLanguages ?? {},
    maxActiveWorkspaces: state.lspMaxActiveWorkspaces ?? LSP_MAX_ACTIVE_WORKSPACES,
    disabledByWorkspace: state.lspDisabledLanguagesByWorkspace ?? {},
  };
}

/**
 * Whether `languageId`'s server runs at all. A bundled language left unset
 * runs; one the user installs runs only once turned on.
 */
export function isLspLanguageOn(settings: LspSettings, languageId: string): boolean {
  const preset: LspServerSpec | undefined = BUILTIN_LSP_PRESETS.find(
    (p) => p.languageId === languageId,
  );
  if (!settings.enabled || !preset) return false;
  const enabled = settings.languages[languageId]?.enabled;
  return preset.system ? enabled === true : enabled !== false;
}

/** Where the user said a language's server is, if they did. */
export function lspServerPath(settings: LspSettings, languageId: string): string | undefined {
  return settings.languages[languageId]?.path?.trim() || undefined;
}

export function isLspLanguageOnForWorkspace(
  settings: LspSettings,
  workspaceId: string,
  languageId: string,
): boolean {
  return (
    isLspLanguageOn(settings, languageId) &&
    !(settings.disabledByWorkspace[workspaceId]?.includes(languageId) ?? false)
  );
}

// typescript-language-server runs a second, syntax-only tsserver that
// answers while the project loads, and a typings installer that fetches
// @types for plain JavaScript. Without both, a workspace of this repository
// took ~515 MB instead of ~850 MB, and the first answer after opening a
// file came ~0.5 s later.
const TYPESCRIPT_LOW_MEMORY_OPTIONS = {
  tsserver: { useSyntaxServer: "never" },
  disableAutomaticTypingAcquisition: true,
};

/** A preset's initializationOptions as the language's settings shape them. */
export function lspInitializationOptions(
  settings: LspSettings,
  languageId: string,
  base: unknown,
): unknown {
  if (languageId !== "typescript" || settings.languages[languageId]?.lowMemory !== true) {
    return base;
  }
  return { ...(base as Record<string, unknown> | undefined), ...TYPESCRIPT_LOW_MEMORY_OPTIONS };
}
