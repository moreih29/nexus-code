// The decisions a viewer makes when the file it shows changes, kept apart from
// the components so they can be tested: which signal says "changed" (local
// watch or another computer's generation), whether a player is left alone, and
// what zoom, place and playback position carry over to the new content.

/**
 * The change signal of one file: another computer's file follows the
 * generation it is read at, any other the watch of the local disk. Both are
 * counters that go up when the file changed, so a viewer reads either alike.
 */
export function fileSignal(isPeer: boolean, local: number, remote: number): number {
  return isPeer ? remote : local;
}

/** Whether a media element is playing now: started, not paused and not ended. */
export function isPlaying(media: { paused: boolean; ended: boolean }): boolean {
  return !media.paused && !media.ended;
}

/**
 * The version a player shows next. A changed file replaces what is shown
 * only while nothing plays; during playback the shown version stays, and
 * `changePending` says a newer one waits.
 */
export function nextShownVersion(shown: number, latest: number, playing: boolean): number {
  return playing ? shown : latest;
}

/** Whether the file changed since the version shown. */
export function changePending(shown: number, latest: number): boolean {
  return shown !== latest;
}

export interface MediaResume {
  /** Where to seek to once the new file's metadata is in; null to start at its beginning. */
  readonly at: number | null;
  /** Whether to play again: only when the reload was asked for during playback. */
  readonly play: boolean;
}

/**
 * Where a reloaded player picks up: the position it was at, if the new file
 * is long enough to hold it (a shorter one, or one that was at its end,
 * starts over). A player that was playing keeps playing.
 */
export function mediaResume(position: number, duration: number, wasPlaying: boolean): MediaResume {
  const keeps = position > 0 && Number.isFinite(duration) && position < duration;
  return { at: keeps ? position : null, play: wasPlaying && keeps };
}

export interface PdfKept {
  /** pdf.js's scale value: a fraction, or "page-width" while fitted. */
  readonly scale: string;
  readonly top: number;
  readonly left: number;
}

/**
 * What a PDF reloaded keeps: the zoom (still "fit to width" where it waits
 * for a width to fit to) and the scroll place, which holds the page too.
 * Null for the first document, which opens fitted to the width at the top.
 */
export function pdfKept(
  hadDocument: boolean,
  fitPending: boolean,
  scaleValue: string,
  top: number,
  left: number,
): PdfKept | null {
  if (!hadDocument) return null;
  return { scale: fitPending ? "page-width" : scaleValue, top, left };
}

/**
 * The sheet a reloaded workbook shows: the one the viewer was on if the new
 * file still has it, else its first.
 */
export function keptSheet<T extends { readonly name: string }>(
  sheets: readonly T[],
  shown: string | null,
): T | undefined {
  return sheets.find((s) => s.name === shown) ?? sheets[0];
}
