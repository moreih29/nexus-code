export interface DictationPlace {
  before: string;
  after: string;
}

export function placeOf(text: string, caret: number): DictationPlace {
  const at = Math.max(0, Math.min(text.length, caret));
  return { before: text.slice(0, at), after: text.slice(at) };
}

export function gapBefore(before: string, heard: string): string {
  if (!before || !heard || /\s$/.test(before) || /^\s/.test(heard)) return "";
  return " ";
}

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
