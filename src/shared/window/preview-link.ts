/**
 * The window name the app opens an HTML preview's link under. The preview's
 * page cannot open windows itself (its sandbox leaves out allow-popups): it
 * asks the app, which calls window.open with this name. Main then lets the
 * link through only while the keyboard is in the preview, so keys typed in
 * the editor do not let the page open links (window/activation.ts).
 */
export const PREVIEW_LINK_WINDOW = "nexus-html-preview-link";
