export function opensTransparentOnLinux(
  windowOpacity: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" && windowOpacity !== undefined && windowOpacity < 1;
}
