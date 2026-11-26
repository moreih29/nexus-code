type GlobalWithDefines = typeof globalThis & {
  __APP_VERSION__?: string;
  __NEXUS_REMOTE_AGENT_ROOT__?: string;
  __NEXUS_REMOTE_AGENT_MANIFEST__?: string;
  __NEXUS_CHANNEL__?: string;
};

const g = globalThis as GlobalWithDefines;

g.__APP_VERSION__ = "1.2.3";
g.__NEXUS_REMOTE_AGENT_ROOT__ ??= "~/.nexus-code";
g.__NEXUS_REMOTE_AGENT_MANIFEST__ ??= "~/.nexus-code/manifest.json";
g.__NEXUS_CHANNEL__ ??= "stable";

Object.defineProperty(globalThis.navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});
