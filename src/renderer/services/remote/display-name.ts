/** Removes format characters, including bidirectional controls, from remote labels. */
export function remoteDisplayName(name: string): string {
  return name.replace(/\p{Cf}/gu, "");
}
