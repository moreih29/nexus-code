import { fromUriPath, toUriPath } from "./drive-path";

const FILE_URI_PREFIX = "file://";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodePath(path: string): string {
  try {
    return path.split("/").map(decodeURIComponent).join("/");
  } catch {
    return path;
  }
}

// A Windows drive path `C:/x` becomes `file:///c%3A/x`, and decodes back to
// `C:/x`.
export function absolutePathToFileUri(path: string): string {
  return `${FILE_URI_PREFIX}${encodePath(toUriPath(path))}`;
}

export function fileUriToAbsolutePath(uri: string): string | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  return fromUriPath(decodePath(uri.slice(FILE_URI_PREFIX.length)));
}
