import { type AgentProfile, PROFILE_DIR_ENV } from "./profiles";

type Environment = Readonly<Record<string, string | undefined>>;

/** The app owns its launch and hook variables on every host. */
export function isReservedProfileEnvName(key: string): boolean {
  return key.toUpperCase().startsWith("NEXUS_");
}

/** Applies environments in order. On Windows the last value and spelling win regardless of case. */
export function mergeAgentEnv(windows: boolean, ...layers: Environment[]): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) entries.set(windows ? key.toUpperCase() : key, [key, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

/** Looks up a variable using the host's rules for its name. */
export function agentEnvValue(env: Environment, key: string, windows: boolean): string | undefined {
  if (!windows) return env[key];
  const upper = key.toUpperCase();
  return Object.entries(env)
    .reverse()
    .find(([name]) => name.toUpperCase() === upper)?.[1];
}

/** Stored profiles may predate the reservation. Filter them at every launch. */
export function profileVariables(
  env: Environment | undefined,
  windows: boolean,
): Record<string, string> {
  const allowed = Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !isReservedProfileEnvName(key)),
  );
  return mergeAgentEnv(windows, allowed);
}

/** An explicit folder beats the profile's provider-specific environment override. */
export function profileDirectory(profile: AgentProfile, windows: boolean): string {
  const key = PROFILE_DIR_ENV[profile.agent];
  return (
    profile.dir.trim() ||
    agentEnvValue(profileVariables(profile.env, windows), key, windows)?.trim() ||
    ""
  );
}
