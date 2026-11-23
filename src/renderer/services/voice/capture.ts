import { frameSamples, pcm16Of } from "./pcm";

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
  level(): number;
  stop(): void;
}

const WORKLET_URL = new URL("./frame-collector.worklet.js", import.meta.url).href;

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

export async function startCapture(
  stream: MediaStream,
  sampleRate: number,
  onFrame: (pcm: Uint8Array) => void,
  options: { keepStream?: boolean; onSamples?: (samples: Float32Array) => void } = {},
): Promise<Capture> {
  const release = () => {
    if (!options.keepStream) for (const track of stream.getTracks()) track.stop();
  };
  let context: AudioContext | null = null;
  try {
    context = new AudioContext({ sampleRate, latencyHint: "interactive" });
    await context.audioWorklet.addModule(WORKLET_URL);
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
      options.onSamples?.(samples);
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
  }
}
