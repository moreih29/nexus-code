/**
 * A text on one line, as the remote lists show it: runs of white space made
 * one space, cut to `max` characters with an ellipsis. Applying it again
 * changes nothing.
 */
export function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
