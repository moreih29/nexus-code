export const PREVIEW_SCHEME = "nexus-preview";

export function previewDocumentUrl(token: string): string {
  return `${PREVIEW_SCHEME}://${token}/`;
}
