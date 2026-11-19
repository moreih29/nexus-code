// Where an MCP server's sign-in sends the browser back: a page on this
// machine, served once, whose address the Claude tab gives Claude Code as
// the redirect (mcp_authenticate's redirectUri). The address the browser
// lands on, with its code, is handed back to the tab, which gives it to
// Claude Code (mcp_oauth_callback_url). It works the same when Claude Code
// runs on an SSH host, whose own callback port the browser cannot reach.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/** How long a sign-in may take before the page is closed. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60_000;

const CALLBACK_PATH = "/callback";

const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NexusCode</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem">
<p>Signed in. You can close this window and go back to NexusCode.</p>
<p>로그인했습니다. 이 창을 닫고 NexusCode로 돌아가세요.</p>
</body></html>`;

interface Pending {
  readonly server: Server;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The address the browser came back to, once it has. */
  url?: string;
  /** Who waits for it: called with it, or null when it will not come. */
  waiters: ((url: string | null) => void)[];
}

/** How long an address the browser came back to is kept for a wait that comes late. */
const KEPT_MS = 60_000;

/** Indicates a sign-in that was cancelled by chat host shutdown. */
export class OAuthCallbacksClosedError extends Error {
  constructor() {
    super("OAuth callbacks are closed");
  }
}

export class OAuthCallbacks {
  private readonly pending = new Map<string, Pending>();
  private readonly arrived = new Map<
    string,
    { url: string; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;

  constructor(private readonly timeoutMs = OAUTH_CALLBACK_TIMEOUT_MS) {}

  /** Serves a page for one sign-in; its address is the redirect to give. */
  async listen(): Promise<{ id: string; redirectUri: string }> {
    if (this.disposed) throw new OAuthCallbacksClosedError();
    const id = randomUUID();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const entry = this.pending.get(id);
      if (url.pathname !== CALLBACK_PATH || !entry || entry.url !== undefined) {
        res.writeHead(404, { Connection: "close" }).end();
        return;
      }
      const port = (server.address() as { port: number }).port;
      entry.url = `http://localhost:${port}${url.pathname}${url.search}`;
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        .end(DONE_PAGE);
      this.finish(id, entry.url);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    if (this.disposed) {
      server.close();
      throw new OAuthCallbacksClosedError();
    }
    const timer = setTimeout(() => this.finish(id, null), this.timeoutMs);
    timer.unref?.();
    this.pending.set(id, { server, timer, waiters: [] });
    const port = (server.address() as { port: number }).port;
    return { id, redirectUri: `http://localhost:${port}${CALLBACK_PATH}` };
  }

  /** The address the browser came back to; null when it timed out, was cancelled or is unknown. */
  wait(id: string): Promise<string | null> {
    const arrived = this.arrived.get(id);
    if (arrived !== undefined) return Promise.resolve(arrived.url);
    const entry = this.pending.get(id);
    if (!entry) return Promise.resolve(null);
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  /** Stops waiting for a sign-in. */
  cancel(id: string): void {
    this.finish(id, null);
  }

  /** Stops pending sign-ins and drops callbacks saved for a late waiter. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.pending.keys()]) this.finish(id, null);
    for (const { timer } of this.arrived.values()) clearTimeout(timer);
    this.arrived.clear();
  }

  private finish(id: string, url: string | null): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    // The page was answered first; the server stops taking new connections.
    entry.server.close();
    if (url !== null) {
      const timer = setTimeout(() => this.arrived.delete(id), KEPT_MS);
      timer.unref?.();
      this.arrived.set(id, { url, timer });
    }
    for (const waiter of entry.waiters.splice(0)) waiter(url);
  }
}
