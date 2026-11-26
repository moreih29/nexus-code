export const SCOPE_HOST_SUFFIX = ".scope";

const SCOPE_ID = /^[0-9a-f]{32}$/;

export function previewScopeUrl(id: string): string {
  return `nexus-workspace://${id}${SCOPE_HOST_SUFFIX}/`;
}

export function previewScopeSource(id: string): string {
  return `nexus-workspace://${id}${SCOPE_HOST_SUFFIX}`;
}

export function scopeIdOf(host: string): string | null {
  if (!host.endsWith(SCOPE_HOST_SUFFIX)) return null;
  const id = host.slice(0, -SCOPE_HOST_SUFFIX.length);
  return SCOPE_ID.test(id) ? id : null;
}

export function scopedSegments(pathname: string): string[] | null {
  const raw = pathname.replace(/^\//, "").split("/");
  const segments: string[] = [];
  for (const part of raw) {
    let name: string;
    try {
      name = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (name === "" || name === "." || name === ".." || /[\\/\0:]/.test(name)) return null;
    segments.push(name);
  }
  return segments;
}
