export const CLAUDE_SETTINGS_ENV = "NEXUS_CLAUDE_SETTINGS";
export const CLAUDE_SERVERLESS_SETTINGS_ENV = "NEXUS_CLAUDE_SERVERLESS_SETTINGS";

export function claudeSettingsEnv(
  env: Record<string, string>,
  withHookServer: boolean,
): Record<string, string> {
  const { [CLAUDE_SERVERLESS_SETTINGS_ENV]: serverless, ...rest } = env;
  if (serverless === undefined) return env;
  return withHookServer ? rest : { ...rest, [CLAUDE_SETTINGS_ENV]: serverless };
}
