import { defaultEffortOf } from "./config";

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function claudeModelLabel(id: string): string {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?(?:\[1m\])?$/.exec(id);
  if (!match) return id;
  const [, family, major, minor] = match;
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

export function settingsModel(answer: unknown): string | undefined {
  const effective = rec(rec(answer)?.effective);
  if (!str(effective?.model)) return undefined;
  return str(rec(rec(answer)?.applied)?.model) ?? str(effective?.model);
}

export function settingsChoice(answer: unknown): string | undefined {
  return str(rec(rec(answer)?.effective)?.model);
}

export function appliedEffort(answer: unknown): string | undefined {
  return str(rec(rec(answer)?.applied)?.effort);
}

export function effortToApply(answer: unknown): string | undefined {
  const effective = rec(rec(answer)?.effective);
  const wanted = effective
    ? defaultEffortOf(effective, str(rec(rec(answer)?.applied)?.model))
    : undefined;
  return wanted !== undefined && wanted !== appliedEffort(answer) ? wanted : undefined;
}

export function remoteAtStartup(init: unknown): boolean {
  const body = rec(init);
  return (
    body?.remote_control_available === true &&
    body.remote_control_auto_enable === true &&
    body.ide_rc_auto_enable_gate !== false
  );
}
