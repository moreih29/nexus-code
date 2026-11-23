export function fileSignal(isPeer: boolean, local: number, remote: number): number {
  return isPeer ? remote : local;
}

export function isPlaying(media: { paused: boolean; ended: boolean }): boolean {
  return !media.paused && !media.ended;
}

export function nextShownVersion(shown: number, latest: number, playing: boolean): number {
  return playing ? shown : latest;
}

export function changePending(shown: number, latest: number): boolean {
  return shown !== latest;
}

export interface MediaResume {
  readonly at: number | null;
  readonly play: boolean;
}

export function mediaResume(position: number, duration: number, wasPlaying: boolean): MediaResume {
  const keeps = position > 0 && Number.isFinite(duration) && position < duration;
  return { at: keeps ? position : null, play: wasPlaying && keeps };
}

export interface PdfKept {
  readonly scale: string;
  readonly top: number;
  readonly left: number;
}

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

export function keptSheet<T extends { readonly name: string }>(
  sheets: readonly T[],
  shown: string | null,
): T | undefined {
  return sheets.find((s) => s.name === shown) ?? sheets[0];
}
