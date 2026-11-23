import { compareVersions } from "../versions";

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
  update_settings: "2.1.318",
  get_hooks_listing: "2.1.288",
  get_plan: "2.1.318",
  cancel_async_message: "2.1.160",
};

const USAGE_SKIPS_BEHAVIORS_FROM = "2.1.318";

export function supportsControl(version: string | null | undefined, subtype: string): boolean {
  const first = FIRST_SEEN[subtype];
  if (!first || !version) return true;
  return compareVersions(version, first) >= 0;
}

export function firstVersionOf(subtype: string): string | undefined {
  return FIRST_SEEN[subtype];
}

export function usageSkipsBehaviors(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, USAGE_SKIPS_BEHAVIORS_FROM) >= 0;
}

export function isSupportedClaude(version: string | null | undefined): boolean {
  return !version || compareVersions(version, MIN_CLAUDE_VERSION) >= 0;
}
