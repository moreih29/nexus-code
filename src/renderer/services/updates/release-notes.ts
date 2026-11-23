import { gt, valid } from "semver";
import type { ReleaseNote } from "../../../shared/updates/release-notes";

export function shownNote(
  notes: readonly ReleaseNote[],
  wanted: string | null,
  current: string,
): ReleaseNote | null {
  return (
    notes.find((note) => note.version === wanted) ??
    notes.find((note) => note.version === current) ??
    notes[0] ??
    null
  );
}

export type ReleaseMark = "current" | "newer" | "prerelease" | null;

export function releaseMark(note: ReleaseNote, current: string): ReleaseMark {
  if (note.version === current) return "current";
  if (valid(current) && gt(note.version, current)) return "newer";
  return note.prerelease ? "prerelease" : null;
}

export function newsVersionOf(lastSeen: string | null, current: string): string | null {
  if (lastSeen === null || !valid(lastSeen) || !valid(current)) return null;
  return gt(current, lastSeen) ? current : null;
}

export function releaseDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
