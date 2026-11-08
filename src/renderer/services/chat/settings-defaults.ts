/**
 * What the user's settings give a Claude tab's program, as get_settings
 * tells it: `effective` is what the settings files say, `applied` what the
 * program runs with. A session names its model only at its first turn, and
 * `claude -p` leaves the settings' effort out (it runs at its own default),
 * so the tab takes both from here. Pure.
 */

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

/** The effort the settings set (effortLevel) that the program does not run at, to set for it. */
export function effortToApply(answer: unknown): string | undefined {
  const wanted = str(rec(rec(answer)?.effective)?.effortLevel);
  return wanted !== undefined && wanted !== appliedEffort(answer) ? wanted : undefined;
}
