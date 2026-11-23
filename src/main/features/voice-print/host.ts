import * as ort from "onnxruntime-node";
import { fbank, frameCount, MEL_BINS, meanNormalized } from "./fbank";

interface Port {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort: Port }).parentPort;

let session: Promise<ort.InferenceSession> | null = null;

async function voicePrint(model: string, audio: Float32Array): Promise<number[]> {
  session ??= ort.InferenceSession.create(model, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  }).catch((error: unknown) => {
    session = null;
    throw error;
  });
  const s = await session;
  const frames = frameCount(audio.length);
  if (!frames) throw new Error("too short");
  const features = meanNormalized(fbank(audio));
  const input = new ort.Tensor("float32", features, [1, frames, MEL_BINS]);
  const output = await s.run({ [s.inputNames[0] as string]: input });
  const data = output[s.outputNames[0] as string]?.data as Float32Array;
  let norm = 0;
  for (const v of data) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(data, (v) => v / norm);
}

port.on("message", (event) => {
  const { id, model, audio } = event.data as { id: number; model: string; audio: Float32Array };
  voicePrint(model, audio).then(
    (vector) => port.postMessage({ id, vector }),
    (error: unknown) => {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    },
  );
});
