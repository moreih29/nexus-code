import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createSshError } from "./pipe";

/** Maximum combined output of one short transport command. */
const MAX_COLLECTED_BYTES = 4 * 1024 * 1024;

interface CollectProcessOptions {
  readonly name: string;
  readonly input?: Buffer | string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

/** Collects one transport command and kills it on cancellation or deadline. */
export function collectProcess(
  child: ChildProcessWithoutNullStreams,
  { name, input, signal, timeoutMs }: CollectProcessOptions,
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(() => {
      stop(createSshError("transport.timeout", new Error(`${name} exceeded ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    /** Drops cancellation hooks once the caller has its result. */
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stdout.length = 0;
      stderr.length = 0;
    };
    /** Keeps the original transport error while terminating the child. */
    const stop = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
      child.kill("SIGKILL");
    };
    const abort = () => stop(signal?.reason);

    /** Collects output only while the command is within its shared byte budget. */
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > MAX_COLLECTED_BYTES) {
        stop(
          createSshError(
            "transport.unknown",
            new Error(`${name} output exceeded ${MAX_COLLECTED_BYTES} bytes`),
          ),
        );
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
      cleanup();
      resolve(result);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A child closing its input can still report the cause on stderr.
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stop(error);
    });
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(input);
    }
  });
}
