import { shortenPaths } from "../chat/tab-title";

/** Keeps remote labels on one line and preserves shaping and emoji sequences. */
export function remoteDisplayName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/\r\n|[\n\r\u0085\u2028\u2029]/gu, " ").replace(/\p{Cf}/gu, (char) => {
    const point = char.codePointAt(0) ?? 0;
    return point === 0x200c || point === 0x200d || (point >= 0xe0020 && point <= 0xe007f)
      ? char
      : "";
  });
}

/**
 * Another computer's conversation title as this one shows it: on one line,
 * each path in it shortened to its last part, as this computer makes its own
 * titles (tab-title.ts). An older app there may have kept the whole path.
 * Only the paths change: no line, sentence or length is cut, so a title the
 * user wrote stays whole; and a title shown once reads the same again. What
 * is kept, and what goes back to that computer, stays as it sent it.
 */
export function remoteTitle(title: unknown): string {
  return shortenPaths(remoteDisplayName(title));
}
