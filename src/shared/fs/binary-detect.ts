import { BINARY_DETECTION_BYTES } from "./defaults";

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
