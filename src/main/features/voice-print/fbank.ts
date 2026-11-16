/**
 * Log mel filter bank features as Kaldi computes them (torchaudio's
 * compliance.kaldi.fbank with its defaults): 25 ms frames every 10 ms, each
 * with its DC offset removed, pre-emphasized (0.97), under a Povey window,
 * zero-padded to 512 and turned into its power spectrum, then 80 mel bands
 * from 20 Hz to the Nyquist frequency, logged. The voice print model was
 * trained on these, the mean over time taken away (meanNormalized).
 *
 * Pure: no IO here.
 */

export const SAMPLE_RATE = 16_000;
export const MEL_BINS = 80;
const FRAME = 400; // 25 ms
const SHIFT = 160; // 10 ms
const FFT = 512;
const PREEMPHASIS = 0.97;
const LOW_HZ = 20;
const EPSILON = 1.1920928955078125e-7; // float32's

const mel = (hz: number) => 1127 * Math.log(1 + hz / 700);

/** The Povey window: a Hann window (not periodic) to the power of 0.85. */
const WINDOW = Float64Array.from(
  { length: FRAME },
  (_, n) => (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FRAME - 1))) ** 0.85,
);

/** Each band's weights over the spectrum's bins (the last bin, the Nyquist one, has none). */
const BANKS: { first: number; weights: Float64Array }[] = (() => {
  const bins = FFT / 2;
  const width = SAMPLE_RATE / FFT;
  const low = mel(LOW_HZ);
  const high = mel(SAMPLE_RATE / 2);
  const delta = (high - low) / (MEL_BINS + 1);
  const banks: { first: number; weights: Float64Array }[] = [];
  for (let b = 0; b < MEL_BINS; b++) {
    const left = low + b * delta;
    const center = left + delta;
    const right = center + delta;
    const weights = new Float64Array(bins);
    let first = -1;
    let last = -1;
    for (let i = 0; i < bins; i++) {
      const m = mel(width * i);
      const w = Math.max(0, Math.min((m - left) / (center - left), (right - m) / (right - center)));
      if (w > 0) {
        if (first < 0) first = i;
        last = i;
      }
      weights[i] = w;
    }
    banks.push({ first, weights: weights.slice(first, last + 1) });
  }
  return banks;
})();

/** The bit-reversed order of FFT's indices, and its twiddles. */
const BITS = Math.log2(FFT);
const REVERSED = Uint16Array.from({ length: FFT }, (_, i) => {
  let r = 0;
  for (let b = 0; b < BITS; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
});
const COS = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / FFT));
const SIN = Float64Array.from({ length: FFT / 2 }, (_, k) => -Math.sin((2 * Math.PI * k) / FFT));

/** In place: the FFT of (re, im), FFT long. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT; i++) {
    const j = REVERSED[i] as number;
    if (j > i) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT; size *= 2) {
    const half = size / 2;
    const step = FFT / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step] as number;
        const s = SIN[k * step] as number;
        const a = start + k;
        const b = a + half;
        const br = re[b] as number;
        const bi = im[b] as number;
        const tr = br * c - bi * s;
        const ti = br * s + bi * c;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
}

/** How many frames `samples` samples make: none if under one frame. */
export function frameCount(samples: number): number {
  return samples < FRAME ? 0 : 1 + Math.floor((samples - FRAME) / SHIFT);
}

/** The features of 16 kHz audio (samples from -1 to 1): frames × MEL_BINS, row by row. */
export function fbank(audio: Float32Array): Float32Array {
  const frames = frameCount(audio.length);
  const out = new Float32Array(frames * MEL_BINS);
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  const power = new Float64Array(FFT / 2);
  const frame = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const at = f * SHIFT;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = audio[at + i] as number;
      frame[i] = v;
      sum += v;
    }
    const mean = sum / FRAME;
    for (let i = 0; i < FRAME; i++) frame[i] = (frame[i] as number) - mean;
    for (let i = FRAME - 1; i > 0; i--) {
      frame[i] = (frame[i] as number) - PREEMPHASIS * (frame[i - 1] as number);
    }
    frame[0] = (frame[0] as number) * (1 - PREEMPHASIS);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = (frame[i] as number) * (WINDOW[i] as number);
    fft(re, im);
    for (let i = 0; i < FFT / 2; i++) {
      const r = re[i] as number;
      const m = im[i] as number;
      power[i] = r * r + m * m;
    }
    for (let b = 0; b < MEL_BINS; b++) {
      const { first, weights } = BANKS[b] as (typeof BANKS)[number];
      let energy = 0;
      for (let i = 0; i < weights.length; i++) {
        energy += (power[first + i] as number) * (weights[i] as number);
      }
      out[f * MEL_BINS + b] = Math.log(Math.max(energy, EPSILON));
    }
  }
  return out;
}

/** In place: each band's mean over the frames taken away. */
export function meanNormalized(features: Float32Array): Float32Array {
  const frames = features.length / MEL_BINS;
  if (!frames) return features;
  for (let b = 0; b < MEL_BINS; b++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += features[f * MEL_BINS + b] as number;
    const mean = sum / frames;
    for (let f = 0; f < frames; f++) {
      features[f * MEL_BINS + b] = (features[f * MEL_BINS + b] as number) - mean;
    }
  }
  return features;
}
