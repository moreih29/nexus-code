import { shortenPaths } from "../chat/tab-title";

export function remoteDisplayName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/\r\n|[\n\r\u0085\u2028\u2029]/gu, " ").replace(/\p{Cf}/gu, (char) => {
    const point = char.codePointAt(0) ?? 0;
    return point === 0x200c || point === 0x200d || (point >= 0xe0020 && point <= 0xe007f)
      ? char
      : "";
  });
}

export function remoteTitle(title: unknown): string {
  return shortenPaths(remoteDisplayName(title));
}
