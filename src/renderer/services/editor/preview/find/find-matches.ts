// Where a preview's find query is in its text.
//
// Self-contained: the HTML preview runs it inside its document too, from
// its source (see dom-finder.ts), so it uses nothing from outside itself.

/**
 * Where `query` is in `text`, as [start, end] offsets one after another,
 * at most `limit` of them. A space in the query stands for any run of
 * white space, as the page shows one, and letters match either case
 * unless `caseSensitive`.
 */
export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  limit: number,
): number[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const pattern = words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("\\s+");
  const regex = new RegExp(pattern, caseSensitive ? "gu" : "giu");
  const found: number[] = [];
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    found.push(match.index, match.index + match[0].length);
    if (found.length >= limit * 2) break;
  }
  return found;
}
