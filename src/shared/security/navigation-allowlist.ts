export const NAVIGATION_SCHEME_ALLOWLIST = ["http:", "https:", "file:"] as const;

export const SUBFRAME_SCHEME_ALLOWLIST = ["data:", "blob:"] as const;

export function isNavigationSchemeAllowed(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (NAVIGATION_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}

export function isTabLoadAllowed(rawUrl: string): boolean {
  return rawUrl === "about:blank" || isNavigationSchemeAllowed(rawUrl);
}

export function isSubframeNavigationAllowed(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return false;
  if (isNavigationSchemeAllowed(rawUrl)) return true;

  return (SUBFRAME_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}

export function isPopupNavigationAllowed(rawUrl: string): boolean {
  if (!isNavigationSchemeAllowed(rawUrl)) return false;
  return new URL(rawUrl).protocol !== "file:";
}

export const CHROMIUM_PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

export function isBuiltinPdfViewerUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (
    parsed.protocol === "chrome-extension:" && parsed.hostname === CHROMIUM_PDF_VIEWER_EXTENSION_ID
  );
}
