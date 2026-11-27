const MAX_IMAGE_VERSIONS = 512;
const versions = new Map<string, string>();

export function localImageVersionKey(workspaceId: string, relPath: string): string {
  return JSON.stringify([workspaceId, relPath]);
}

export function lastImageVersion(key: string): string | undefined {
  return versions.get(key);
}

export function rememberImageVersion(key: string, version: string): void {
  versions.delete(key);
  versions.set(key, version);
  if (versions.size <= MAX_IMAGE_VERSIONS) return;
  const oldest = versions.keys().next();
  if (!oldest.done) versions.delete(oldest.value);
}

export function forgetImageVersion(key: string): void {
  versions.delete(key);
}
