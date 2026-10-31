/**
 * The OS the renderer runs on. The preload reports it as
 * `window.host.platform` (process.platform); without a preload, as in unit
 * tests, navigator.platform decides, and unknown means macOS.
 *
 * Read it through these functions at the time of use rather than once at
 * module load, so a test can pin a platform with `setPlatformForTests` and
 * exercise that platform's path.
 */

/** process.platform's values: "darwin" | "win32" | "linux" | … */
export type HostPlatform = Window["host"]["platform"];

let pinned: HostPlatform | null = null;

export function hostPlatform(): HostPlatform {
  if (pinned !== null) return pinned;
  if (typeof window !== "undefined" && window.host?.platform) return window.host.platform;
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  if (/Win/i.test(platform)) return "win32";
  if (/Linux|X11/i.test(platform)) return "linux";
  return "darwin";
}

export function isMac(): boolean {
  return hostPlatform() === "darwin";
}

export function isWindows(): boolean {
  return hostPlatform() === "win32";
}

export function isLinux(): boolean {
  return hostPlatform() === "linux";
}

/** Test-only: makes `hostPlatform` answer `platform` until called with null. */
export function setPlatformForTests(platform: HostPlatform | null): void {
  pinned = platform;
}
