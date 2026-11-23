import { type AgentProfile, PROFILE_DIR_ENV } from "./profiles";

type Environment = Readonly<Record<string, string | undefined>>;

export function isReservedProfileEnvName(key: string): boolean {
  return key.toUpperCase().startsWith("NEXUS_");
}

export function mergeAgentEnv(windows: boolean, ...layers: Environment[]): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) entries.set(windows ? key.toUpperCase() : key, [key, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

export function agentEnvValue(env: Environment, key: string, windows: boolean): string | undefined {
  if (!windows) return env[key];
  const upper = key.toUpperCase();
  return Object.entries(env)
    .reverse()
    .find(([name]) => name.toUpperCase() === upper)?.[1];
}

export function profileVariables(
  env: Environment | undefined,
  windows: boolean,
): Record<string, string> {
  const allowed = Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !isReservedProfileEnvName(key)),
  );
  return mergeAgentEnv(windows, allowed);
}

export function profileDirectory(profile: AgentProfile, windows: boolean): string {
  const key = PROFILE_DIR_ENV[profile.agent];
  return (
    profile.dir.trim() ||
    agentEnvValue(profileVariables(profile.env, windows), key, windows)?.trim() ||
    ""
  );
}
