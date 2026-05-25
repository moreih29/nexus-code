/**
 * Bun test global setup — preloaded before each test file via bunfig.toml.
 *
 * Provides stable default values for the build-time define constants
 * (__NEXUS_REMOTE_AGENT_ROOT__, __NEXUS_REMOTE_AGENT_MANIFEST__, __NEXUS_CHANNEL__)
 * that Vite replaces at bundle time. Under Bun test there is no bundler pass,
 * so these identifiers remain as bare globals. Nullish assignment (??=) ensures
 * that a test file that sets them earlier is not overwritten.
 */

type GlobalWithDefines = typeof globalThis & {
  __NEXUS_REMOTE_AGENT_ROOT__?: string;
  __NEXUS_REMOTE_AGENT_MANIFEST__?: string;
  __NEXUS_CHANNEL__?: string;
};

const g = globalThis as GlobalWithDefines;

g.__NEXUS_REMOTE_AGENT_ROOT__ ??= "~/.nexus-code";
g.__NEXUS_REMOTE_AGENT_MANIFEST__ ??= "~/.nexus-code/manifest.json";
g.__NEXUS_CHANNEL__ ??= "stable";
