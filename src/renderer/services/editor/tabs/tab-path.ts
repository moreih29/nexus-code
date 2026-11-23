import { reducePosixSegments } from "../../../../shared/fs/posix-segments";

export function normalizeFilePath(filePath: string): string {
  if (filePath === "") return ".";
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
