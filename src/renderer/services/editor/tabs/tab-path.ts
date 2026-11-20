import { reducePosixSegments } from "../../../../shared/fs/posix-segments";

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
  // A Windows drive letter is case-insensitive: `c:/a` and `C:/a` are one file.
  if (/^[a-z]:\//.test(filePath)) filePath = filePath[0].toUpperCase() + filePath.slice(1);

  const isAbsolute = filePath.startsWith("/");
  const hasTrailingSlash = filePath.endsWith("/");
  const parts = reducePosixSegments(filePath, {
    emptySegments: "discard",
    leadingParents: isAbsolute ? "discard" : "keep",
  });

  let normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`;
  if (normalized === "") normalized = isAbsolute ? "/" : ".";
  if (hasTrailingSlash && normalized !== "/") normalized += "/";
  return normalized;
}
