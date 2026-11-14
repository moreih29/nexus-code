/**
 * The microphone, captured for voice input: getUserMedia, then an
 * AudioContext at the rate the server asked for (Chromium resamples the
 * microphone to it), then an AudioWorklet that hands over FRAME_MS of
 * samples at a time, sent on as PCM 16-bit little-endian. Silence is sent
 * too: the server ends a session that hears nothing for a while.
 */

import { frameSamples, pcm16Of } from "./pcm";

/** Why the microphone could not be captured. */
export type CaptureFailure = "denied" | "no-microphone" | "failed";

export class CaptureError extends Error {
  constructor(
    readonly reason: CaptureFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface Capture {
  /** How loud the last frame was, 0 to 1. */
  level(): number;
  stop(): void;
}

/** The worklet: collects `frame` samples of the first channel, then posts them. */
const WORKLET = `
class FrameCollector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = options.processorOptions.frame;
    this.buffer = new Float32Array(this.frame);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.frame - this.filled);
      this.buffer.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.frame) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.frame);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("nexus-frame-collector", FrameCollector);
`;

/** Asks for the microphone; the stream, or why not. */
export async function openMicrophone(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CaptureError("denied", message);
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new CaptureError("no-microphone", message);
    }
    throw new CaptureError("failed", message);
  }
}

/**
 * Captures `stream` at `sampleRate`, handing each frame to `onFrame`.
 * Stopping it (or failing) stops the stream's tracks too, unless
 * `keepStream`: a note's recording goes on with the stream in a new session.
 */
export async function startCapture(
  stream: MediaStream,
  sampleRate: number,
  onFrame: (pcm: Uint8Array) => void,
  options: { keepStream?: boolean } = {},
): Promise<Capture> {
  const release = () => {
    if (!options.keepStream) for (const track of stream.getTracks()) track.stop();
  };
  let context: AudioContext | null = null;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  try {
    context = new AudioContext({ sampleRate, latencyHint: "interactive" });
    await context.audioWorklet.addModule(url);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "nexus-frame-collector", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { frame: frameSamples(sampleRate) },
    });
    let level = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      let sum = 0;
      for (const s of samples) sum += s * s;
      level = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
      onFrame(pcm16Of(samples));
    };
    source.connect(node);
    const opened = context;
    return {
      level: () => level,
      stop: () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        release();
        void opened.close().catch(() => {});
      },
    };
  } catch (error) {
    release();
    void context?.close().catch(() => {});
    throw new CaptureError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    URL.revokeObjectURL(url);
  }
}
