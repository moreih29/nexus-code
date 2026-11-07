/**
 * What the release notes view shows: which release is open, how each one
 * in the list is marked, and whether the title bar offers the notes of the
 * version an update brought. Pure.
 */

import { gt, valid } from "semver";
import type { ReleaseNote } from "../../../shared/updates/release-notes";

/**
 * The release to show: the one asked for, else the running version's, else
 * the newest. Null while there are none.
 */
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

/** How a release in the list is marked beside its version. */
export type ReleaseMark = "current" | "newer" | "prerelease" | null;

export function releaseMark(note: ReleaseNote, current: string): ReleaseMark {
  if (note.version === current) return "current";
  if (valid(current) && gt(note.version, current)) return "newer";
  return note.prerelease ? "prerelease" : null;
}

/**
 * The version whose notes the title bar offers: the running one, once an
 * update has brought it past the version whose notes the user last saw.
 * Null when there is nothing new, or before anything was seen (the first
 * launch takes the running version as seen).
 */
export function newsVersionOf(lastSeen: string | null, current: string): string | null {
  if (lastSeen === null || !valid(lastSeen) || !valid(current)) return null;
  return gt(current, lastSeen) ? current : null;
}

/** The date of a release in the reader's language, as "Nov 5, 2026". */
export function releaseDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
