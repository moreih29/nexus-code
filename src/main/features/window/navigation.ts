export function isAllowedMainWindowNavigation(
  url: string,
  devServerUrl: string | undefined,
): boolean {
  if (devServerUrl === undefined) return false;
  try {
    const devOrigin = new URL(devServerUrl).origin;
    return devOrigin !== "null" && new URL(url).origin === devOrigin;
  } catch {
    return false;
  }
}
