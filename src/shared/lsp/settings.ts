import { z } from "zod";
import { IntegerSchema } from "../../../packages/remote-protocol/src/validation";
import { LSP_MAX_ACTIVE_WORKSPACES } from "../util/timing-constants";
import { BUILTIN_LSP_PRESETS, type LspServerSpec } from "./config";

export const LSP_SERVER_PATH_MAX = 4096;

export const LspLanguageSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  lowMemory: z.boolean().optional(),
  path: z.string().max(LSP_SERVER_PATH_MAX).optional(),
});
export type LspLanguageSettings = z.infer<typeof LspLanguageSettingsSchema>;

export const LSP_MAX_ACTIVE_WORKSPACES_LIMIT = 16;

export const LspSettingsSchema = z.object({
  enabled: z.boolean(),
  languages: z.record(z.string(), LspLanguageSettingsSchema),
  maxActiveWorkspaces: IntegerSchema.check(z.gte(1)).check(z.lte(LSP_MAX_ACTIVE_WORKSPACES_LIMIT)),
  disabledByWorkspace: z.record(z.string(), z.array(z.string())),
});
export type LspSettings = z.infer<typeof LspSettingsSchema>;

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

export function isLspLanguageChosen(
  languageId: string,
  languageSettings: LspLanguageSettings | undefined,
): boolean {
  const preset: LspServerSpec | undefined = BUILTIN_LSP_PRESETS.find(
    (p) => p.languageId === languageId,
  );
  if (!preset) return false;
  const enabled = languageSettings?.enabled;
  return preset.system ? enabled === true : enabled !== false;
}

export function isLspLanguageOn(settings: LspSettings, languageId: string): boolean {
  return settings.enabled && isLspLanguageChosen(languageId, settings.languages[languageId]);
}

export type LspPathLanguage = Extract<
  (typeof BUILTIN_LSP_PRESETS)[number],
  { readonly system: true }
>["languageId"];

export const LSP_PATH_LANGUAGES: readonly LspPathLanguage[] = BUILTIN_LSP_PRESETS.flatMap(
  (preset) => ("system" in preset && preset.system ? [preset.languageId] : []),
);

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

const TYPESCRIPT_LOW_MEMORY_OPTIONS = {
  tsserver: { useSyntaxServer: "never" },
  disableAutomaticTypingAcquisition: true,
};

export function isLspLowMemory(languageSettings: LspLanguageSettings | undefined): boolean {
  return languageSettings?.lowMemory !== false;
}

export function lspInitializationOptions(
  settings: LspSettings,
  languageId: string,
  base: unknown,
): unknown {
  if (languageId !== "typescript" || !isLspLowMemory(settings.languages[languageId])) {
    return base;
  }
  return { ...(base as Record<string, unknown> | undefined), ...TYPESCRIPT_LOW_MEMORY_OPTIONS };
}
