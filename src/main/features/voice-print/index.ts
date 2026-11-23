import fs from "node:fs";
import path from "node:path";
import { MAX_VOICE_PRINT_SAMPLES as MAX_SAMPLES } from "../../../shared/types/notes";

export const INT8_MODEL = "campp-zh-en-int8.onnx";
export const FULL_MODEL = "campp-zh-en.onnx";
export const IDLE_MS = 3 * 60_000;
const ASK_TIMEOUT_MS = 30_000;

function electronApp(): typeof import("electron").app {
  return (require("electron") as typeof import("electron")).app;
}

export function voicePrintModel(
  places: readonly string[],
  platform = process.platform,
  arch = process.arch,
): string | null {
  const order =
    platform === "darwin" && arch === "arm64" ? [INT8_MODEL, FULL_MODEL] : [FULL_MODEL, INT8_MODEL];
  for (const name of order) {
    for (const dir of places) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function modelPlaces(): string[] {
  const app = electronApp();
  if (app.isPackaged) return [path.join(process.resourcesPath, "voice-print")];
  const root = app.getAppPath();
  return [path.join(root, "resources", "voice-print"), path.join(root, "dist", "voice-print")];
}

interface Pending {
  resolve(vector: number[] | null): void;
  timer: ReturnType<typeof setTimeout>;
}

export class VoicePrints {
  private child: import("electron").UtilityProcess | null = null;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private model: string | null | undefined;

  constructor(private readonly hostPath: string) {}

  vector(audio: Float32Array): Promise<number[] | null> {
    this.model ??= voicePrintModel(modelPlaces());
    if (!this.model) return Promise.resolve(null);
    const child = this.start();
    if (!child) return Promise.resolve(null);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, ASK_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      child.postMessage({
        id,
        model: this.model,
        audio: audio.length > MAX_SAMPLES ? audio.slice(0, MAX_SAMPLES) : audio,
      });
    });
  }

  private start(): import("electron").UtilityProcess | null {
    if (this.child) return this.child;
    try {
      const { utilityProcess } = require("electron") as typeof import("electron");
      const child = utilityProcess.fork(this.hostPath, [], {
        serviceName: "NexusCode voice print",
      });
      child.on("message", (message: { id: number; vector?: number[]; error?: string }) => {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) console.warn(`[voice-print] ${message.error}`);
        p.resolve(message.vector ?? null);
      });
      child.on("exit", (code) => {
        if (this.child !== child) return;
        this.child = null;
        if (code) console.warn(`[voice-print] the model's process ended (${code})`);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve(null);
          this.pending.delete(id);
        }
      });
      this.child = child;
      return child;
    } catch (error) {
      console.warn(`[voice-print] the model's process did not start: ${String(error)}`);
      return null;
    }
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
      this.pending.delete(id);
    }
  }
}
