import { release } from "node:os";

const WINDOWS_BACKDROP_MIN_BUILD = 22621;

export function supportsWindowsBackdrop(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): boolean {
  if (platform !== "win32") return false;
  const build = Number(osRelease.split(".")[2]);
  return build >= WINDOWS_BACKDROP_MIN_BUILD;
}
