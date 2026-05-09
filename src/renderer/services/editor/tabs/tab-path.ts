/**
 * Path normalization used by tab-lookup matchers.
 *
 * Drops empty segments and `.`, collapses `..` against parent segments
 * while preserving leading `..` in relative paths, preserves trailing
 * slash. Pure — no IO, no platform branching — so two tab.props.filePath
 * values that point at the same file compare equal regardless of how
 * the caller spelled them ("./a/../b" vs "b" etc.).
 */
export function normalizeFilePath(filePath: string): string {
  if (filePath === "") return ".";

  const isAbsolute = filePath.startsWith("/");
  const hasTrailingSlash = filePath.endsWith("/");
  const parts: string[] = [];

  for (const part of filePath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const previous = parts.at(-1);
      if (previous && previous !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  let normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`;
  if (normalized === "") normalized = isAbsolute ? "/" : ".";
  if (hasTrailingSlash && normalized !== "/") normalized += "/";
  return normalized;
}
