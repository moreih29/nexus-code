/**
 * Ambient declarations for build-time define constants injected by Vite
 * (electron.vite.config.ts main config). These identifiers are replaced with
 * string literals at bundle time, so they must not appear as real variables in
 * source — only referenced through the escape-hatch pattern in types.ts.
 */
declare const __NEXUS_REMOTE_AGENT_ROOT__: string;
declare const __NEXUS_REMOTE_AGENT_MANIFEST__: string;
declare const __NEXUS_CHANNEL__: string;
