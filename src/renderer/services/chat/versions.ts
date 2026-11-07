// Which control requests a Claude Code version answers, as measured on
// 2.1.0, 2.1.29, 2.1.77, 2.1.160, 2.1.238, 2.1.288, 2.1.311 and 2.1.318
// (#159). Each version is the first sampled one that had it; the request
// may have come in a release between it and the one sampled before.

/** Below this the tab does not run: the app's protocol starts here. */
export const MIN_CLAUDE_VERSION = "2.1.0";

const FIRST_SEEN: Record<string, string> = {
  apply_flag_settings: "2.1.77",
  generate_session_title: "2.1.77",
  get_context_usage: "2.1.160",
  file_suggestions: "2.1.160",
  background_tasks: "2.1.160",
  rename_session: "2.1.160",
  reload_plugins: "2.1.160",
  get_usage: "2.1.238",
  stop_task: "2.1.238",
  list_permission_rules: "2.1.288",
  get_hooks_listing: "2.1.288",
  // Answered from 2.1.77, but only from 2.1.160 is the drop told by a
  // command_lifecycle event, which takes the message off the list.
  cancel_async_message: "2.1.160",
};

/** -1, 0 or 1 as a is before, the same as, or after b; x.y.z only. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the version answers a control request. An unknown version is
 * tried: every request has a timeout.
 */
export function supportsControl(version: string | null | undefined, subtype: string): boolean {
  const first = FIRST_SEEN[subtype];
  if (!first || !version) return true;
  return compareVersions(version, first) >= 0;
}

/** The version a control request first answered in, for the note on a hidden control. */
export function firstVersionOf(subtype: string): string | undefined {
  return FIRST_SEEN[subtype];
}

export function isSupportedClaude(version: string | null | undefined): boolean {
  return !version || compareVersions(version, MIN_CLAUDE_VERSION) >= 0;
}
