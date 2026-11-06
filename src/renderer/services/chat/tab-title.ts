// A chat tab's title: the first sentence of its first message, kept short,
// until the agent names the conversation.

/** Longest title a tab keeps; the tab strip shows less and the rest on hover. */
export const TITLE_CHARS = 60;

/** The end of a sentence: stops followed by a space or the end of the line. */
const SENTENCE_END = /[.!?。！？]+(?=\s|$)/;

/** A tab's title from a message: its first line's first sentence, cut to length. */
export function titleOf(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  const end = SENTENCE_END.exec(line);
  if (!end) return clipTitle(line);
  // A full stop is left out; a question, or an ellipsis, keeps its marks.
  const stop = end[0] === "." || end[0] === "。" ? "" : end[0];
  return clipTitle(line.slice(0, end.index) + stop || line);
}

/** A title cut to length, with an ellipsis where it was cut. */
export function clipTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}
