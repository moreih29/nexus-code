/**
 * The scheme the HTML preview's documents are served from (main's
 * custom-protocols/nexus-preview.ts). A frame whose document comes from a
 * scheme of its own does not take on the app window's Content-Security-
 * Policy, as a srcdoc frame would: the page keeps its scripts, CDN loads and
 * forms under the looser policy its response carries.
 */
export const PREVIEW_SCHEME = "nexus-preview";

/** The address of the preview document that `token` names. */
export function previewDocumentUrl(token: string): string {
  return `${PREVIEW_SCHEME}://${token}/`;
}
