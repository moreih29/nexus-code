/**
 * What the user's settings give a Claude tab's program, as get_settings
 * tells it: `effective` is what the settings files say, `applied` what the
 * program runs with. A session names its model only at its first turn, and
 * `claude -p` leaves the settings' effortLevel out (it takes only a model's
 * own, under modelSettings), so the tab takes both from here. Pure.
 */

import { defaultEffortOf } from "./claude-config";

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The model the user set, as the program runs it ("claude-opus-5-5[1m]");
 * none when no setting names one, and the default runs.
 */
export function settingsModel(answer: unknown): string | undefined {
  const effective = rec(rec(answer)?.effective);
  if (!str(effective?.model)) return undefined;
  return str(rec(rec(answer)?.applied)?.model) ?? str(effective?.model);
}

/** The effort the program runs at. */
export function appliedEffort(answer: unknown): string | undefined {
  return str(rec(rec(answer)?.applied)?.effort);
}

/**
 * The effort the settings set for the model the program runs that it does
 * not run at, to set for it: the model's own (modelSettings), which a
 * headless run takes, else effortLevel, which it leaves out.
 */
export function effortToApply(answer: unknown): string | undefined {
  const effective = rec(rec(answer)?.effective);
  const wanted = effective
    ? defaultEffortOf(effective, str(rec(rec(answer)?.applied)?.model))
    : undefined;
  return wanted !== undefined && wanted !== appliedEffort(answer) ? wanted : undefined;
}

/**
 * Whether initialize says to turn Remote Control on as the session starts:
 * the user set it on at startup (/config remoteControl), and it can be.
 * Claude Code leaves that to the host in a headless run.
 */
export function remoteAtStartup(init: unknown): boolean {
  const body = rec(init);
  return (
    body?.remote_control_available === true &&
    body.remote_control_auto_enable === true &&
    body.ide_rc_auto_enable_gate !== false
  );
}
