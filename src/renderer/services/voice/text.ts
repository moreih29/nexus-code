/**
 * Where dictated text goes in a composer's text, and how it joins. The
 * server puts the space between segments itself (every partial and final
 * after the session's first final starts with it), so the finals are
 * joined as they came, then the partial, with nothing trimmed or added.
 * Only before the first segment does the composer add a space, when the
 * text before the caret ends in a word. Pure.
 */

/** The text around where dictation began: before and after the caret. */
export interface DictationPlace {
  before: string;
  after: string;
}

export function placeOf(text: string, caret: number): DictationPlace {
  const at = Math.max(0, Math.min(text.length, caret));
  return { before: text.slice(0, at), after: text.slice(at) };
}

/** What goes between the text before the caret and the dictation. */
export function gapBefore(before: string, heard: string): string {
  if (!before || !heard || /\s$/.test(before) || /^\s/.test(heard)) return "";
  return " ";
}

/** The composer's text while (and after) dictating, with where the partial lies in it. */
export function dictatedText(
  place: DictationPlace,
  finals: string,
  partial: string,
): { text: string; partialStart: number; partialEnd: number } {
  const heard = finals + partial;
  const head = place.before + gapBefore(place.before, heard) + finals;
  const text = head + partial + place.after;
  return { text, partialStart: head.length, partialEnd: head.length + partial.length };
}
