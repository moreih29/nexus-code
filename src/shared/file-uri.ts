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

export function absolutePathToFileUri(path: string): string {
  return `${FILE_URI_PREFIX}${encodePath(path)}`;
}

export function fileUriToAbsolutePath(uri: string): string | null {
  if (!uri.startsWith(FILE_URI_PREFIX)) return null;
  return decodePath(uri.slice(FILE_URI_PREFIX.length));
}
