export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;

export function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

export function pxToRatio(px: number, totalSize: number): number {
  if (totalSize === 0) return 0.5;
  return clampRatio(px / totalSize);
}

export function ratioToPx(ratio: number, totalSize: number): number {
  return clampRatio(ratio) * totalSize;
}
