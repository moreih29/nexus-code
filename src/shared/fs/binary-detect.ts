import { BINARY_DETECTION_BYTES } from "./defaults";

/**
 * Returns true if `buf` looks like binary content.
 *
 * Heuristics (in order):
 * 1. UTF-16 LE BOM (FF FE) or UTF-16 BE BOM (FE FF) at byte 0–1 → binary.
 * 2. Any NUL byte in the first BINARY_DETECTION_BYTES → binary.
 *
 * Caller must pass at most BINARY_DETECTION_BYTES bytes; the function
 * never reads beyond buf.length.
 */
export function isBinaryProbe(buf: Buffer): boolean {
  const probe = buf.length <= BINARY_DETECTION_BYTES ? buf : buf.slice(0, BINARY_DETECTION_BYTES);

  if (
    (probe.length >= 2 && probe[0] === 0xff && probe[1] === 0xfe) ||
    (probe.length >= 2 && probe[0] === 0xfe && probe[1] === 0xff)
  ) {
    return true;
  }

  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0x00) {
      return true;
    }
  }

  return false;
}
