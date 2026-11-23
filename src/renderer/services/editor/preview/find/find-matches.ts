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
