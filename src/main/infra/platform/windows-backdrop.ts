import { release } from "node:os";

// Windows 11 22H2: the first build where DWM paints a system backdrop
// (acrylic, mica) behind a window, which Electron's `backgroundMaterial` needs.
const WINDOWS_BACKDROP_MIN_BUILD = 22621;

/**
 * True when the window can show a system backdrop: Windows 11 22H2 or later.
 * `osRelease` is `os.release()`, "10.0.<build>" on Windows.
 */
export function supportsWindowsBackdrop(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): boolean {
  if (platform !== "win32") return false;
  const build = Number(osRelease.split(".")[2]);
  return build >= WINDOWS_BACKDROP_MIN_BUILD;
}
