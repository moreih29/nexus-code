/**
 * Whether the main window may follow a navigation to `url`.
 *
 * The app is a single page and never navigates its window; any page that got
 * loaded into it would run with the preload. The one exception is the
 * electron-vite dev server reloading its own page (a Vite full reload), so
 * only a same-origin navigation is allowed, and only while `devServerUrl` is
 * set, which an unpackaged build alone does.
 */
export function isAllowedMainWindowNavigation(
  url: string,
  devServerUrl: string | undefined,
): boolean {
  if (devServerUrl === undefined) return false;
  try {
    const devOrigin = new URL(devServerUrl).origin;
    // file: and other opaque origins serialize as "null"; never match those.
    return devOrigin !== "null" && new URL(url).origin === devOrigin;
  } catch {
    return false;
  }
}
