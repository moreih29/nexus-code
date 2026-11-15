// The account's recognition terms as the settings edit them: what the user
// types, split at commas and line breaks, added to the list the server
// keeps (GET/PUT /voice/terms), which trims them and drops duplicates in
// any case the same way.

import { MAX_VOICE_TERM_CHARS, MAX_VOICE_TERMS } from "../../../shared/remote/voice";

/** The terms in what the user typed or pasted: split at commas and line breaks, trimmed. */
export function splitTerms(input: string): string[] {
  return input
    .split(/[,，、\r\n]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

export type AddTerms =
  | { status: "ok"; terms: string[] }
  /** Nothing new: empty, or only terms the list has. */
  | { status: "none" }
  /** A term over MAX_VOICE_TERM_CHARS: nothing is added. */
  | { status: "too-long" }
  /** The list would go over MAX_VOICE_TERMS: nothing is added. */
  | { status: "too-many" };

/**
 * The list with the terms of `input` after it, each once whatever its
 * case; or why they are not added.
 */
export function addTerms(list: readonly string[], input: string): AddTerms {
  const typed = splitTerms(input);
  if (typed.some((term) => term.length > MAX_VOICE_TERM_CHARS)) return { status: "too-long" };
  const seen = new Set(list.map((term) => term.toLowerCase()));
  const added: string[] = [];
  for (const term of typed) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(term);
  }
  if (added.length === 0) return { status: "none" };
  if (list.length + added.length > MAX_VOICE_TERMS) return { status: "too-many" };
  return { status: "ok", terms: [...list, ...added] };
}

/** The list without `term`. */
export function removeTerm(list: readonly string[], term: string): string[] {
  return list.filter((t) => t !== term);
}

/**
 * Text pasted into the one-line field, where its line breaks would be
 * dropped: they become commas, so each line stays a term of its own.
 */
export function pastedTerms(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(", ");
}
