/**
 * Microphone samples as the voice socket takes them: 16-bit signed PCM,
 * little-endian, mono, in frames of about FRAME_MS. Pure.
 */

/** How much audio one frame carries. */
export const FRAME_MS = 100;

/** Samples in one frame at `sampleRate`. */
export function frameSamples(sampleRate: number): number {
  return Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
}

/** Float samples in [-1, 1] as PCM 16-bit little-endian bytes; out of range is clipped. */
export function pcm16Of(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return bytes;
}
