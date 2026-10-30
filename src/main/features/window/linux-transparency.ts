/**
 * True when the window opens transparent on Linux: only while the saved window
 * opacity is under 100%. Electron draws no frame around a transparent Linux
 * window (no window controls, shadow, rounded corners or resize border), so a
 * window kept at 100% keeps its frame. `transparent` is a constructor-only
 * option, so crossing 100% applies at the next launch.
 */
export function opensTransparentOnLinux(
  windowOpacity: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" && windowOpacity !== undefined && windowOpacity < 1;
}
