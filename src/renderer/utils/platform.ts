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

export function setPlatformForTests(platform: HostPlatform | null): void {
  pinned = platform;
}
