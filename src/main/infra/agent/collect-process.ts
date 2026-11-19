import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createSshError } from "./pipe";

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
    const timer = setTimeout(() => {
      stop(createSshError("transport.timeout", new Error(`${name} exceeded ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    /** Drops cancellation hooks once the caller has its result. */
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    /** Keeps the original transport error while terminating the child. */
    const stop = (error: unknown) => {
      cleanup();
      reject(error);
      child.kill("SIGKILL");
    };
    const abort = () => stop(signal?.reason);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
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
