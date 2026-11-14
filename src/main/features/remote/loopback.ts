/**
 * The address the browser comes back to after the sign-in (RFC 8252's
 * loopback redirect): a server on 127.0.0.1, on a port the system picks,
 * that takes one /callback and closes.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignInError } from "./errors";

/** What the server sent the browser back with. */
export interface Callback {
  code?: string;
  error?: string;
  state: string | null;
}

export interface LoopbackListener {
  /** The redirect_uri to give the server. */
  readonly redirectUri: string;
  /**
   * The callback, or a SignInError once the time is up ("timed-out") or the
   * sign-in is stopped ("cancelled").
   */
  readonly result: Promise<Callback>;
  /** Stops waiting; the result rejects as cancelled. */
  close(): void;
}

/** The page the browser shows once it is back: the sign-in went on in the app. */
function page(ok: boolean): string {
  const text = ok
    ? "Signed in. You can close this tab and go back to NexusCode."
    : "The sign-in did not finish. Go back to NexusCode to try again.";
  return `<!doctype html><meta charset="utf-8"><title>NexusCode</title><body style="font:16px system-ui;padding:48px">${text}</body>`;
}

export async function listenForCallback(timeoutMs: number): Promise<LoopbackListener> {
  let settle: { resolve(c: Callback): void; reject(e: Error): void } | null = null;
  const result = new Promise<Callback>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nothing waits on it until the sign-in does; a rejection then is not unhandled.
  result.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(!!code && !error));
    finish(() => settle?.resolve({ code, error, state: url.searchParams.get("state") }));
  });
  const timer = setTimeout(() => stop("timed-out"), timeoutMs);
  let done = false;
  const finish = (then: () => void) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    then();
  };
  const stop = (failure: "cancelled" | "timed-out") => {
    finish(() => settle?.reject(new SignInError(failure)));
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: () => stop("cancelled"),
  };
}
