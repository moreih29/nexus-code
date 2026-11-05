/**
 * The requests each browser tab's pages made, kept from the tab's start for
 * nexus browser network, from the Chrome DevTools Protocol's Network events.
 */

/** A request a page made, and what came of it so far. */
export interface NetworkEntry {
  /** The request's number in its tab, from 1, which nexus browser network takes. */
  readonly id: number;
  /** When it was sent, in ms since the epoch. */
  readonly at: number;
  readonly method: string;
  readonly url: string;
  /** What the page asked for it as, lowercase: document, fetch, xhr, script, image... */
  readonly type: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  /** Why it failed: the network error, or "canceled". */
  readonly failure?: string;
  /** How many bytes came over the network for it, once done. */
  readonly size?: number;
  /** How long it took, once done. */
  readonly ms?: number;
  /** Whether it came from the cache. */
  readonly cached?: boolean;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** What was sent with it, when the page told it. */
  readonly postData?: string;
  /** Whether something was sent with it, told or not. */
  readonly hasPostData: boolean;
  /** Where it went on to, for a redirect. */
  readonly redirectedTo?: string;
}

/** How many requests a tab keeps; older ones go first. */
export const NETWORK_LIMIT = 500;

/** The protocol's id for the request, which its body is asked by. */
interface Recorded extends Mutable<NetworkEntry> {
  readonly requestId: string;
  /** When it was sent, in the protocol's seconds. */
  readonly started: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class NetworkLog {
  private entries: Recorded[] = [];
  /** The request each protocol id is at; a redirect moves it on to the next. */
  private readonly current = new Map<string, Recorded>();
  private next = 1;

  constructor(private readonly now: () => number = Date.now) {}

  /** Takes a Network event of the page's. */
  handle(method: string, params: Record<string, unknown>): void {
    const entry =
      method === "Network.requestWillBeSent"
        ? undefined
        : this.current.get(String(params.requestId));
    if (method === "Network.requestWillBeSent") this.sent(params);
    else if (method === "Network.responseReceived")
      this.answered(entry, params.response as Response);
    else if (method === "Network.requestServedFromCache" && entry) entry.cached = true;
    else if (method === "Network.loadingFinished" && entry) {
      entry.ms = msBetween(entry.started, params.timestamp);
      entry.size = Number(params.encodedDataLength ?? 0);
    } else if (method === "Network.loadingFailed" && entry) {
      entry.ms = msBetween(entry.started, params.timestamp);
      entry.failure = params.canceled ? "canceled" : String(params.errorText ?? "");
    }
  }

  /** The requests so far; with `clear`, forgets them. */
  read(clear: boolean): readonly NetworkEntry[] {
    const entries = this.entries.map(publicEntry);
    if (clear) {
      this.entries = [];
      this.current.clear();
    }
    return entries;
  }

  /** The request numbered `id`, with the protocol's id for it; undefined once gone. */
  find(id: number): { entry: NetworkEntry; requestId: string } | undefined {
    const found = this.entries.find((e) => e.id === id);
    return found && { entry: publicEntry(found), requestId: found.requestId };
  }

  private sent(params: Record<string, unknown>): void {
    const requestId = String(params.requestId);
    const request = (params.request ?? {}) as Request;
    const url = String(request.url ?? "");
    if (url.startsWith("data:")) return;
    const redirect = params.redirectResponse as Response | undefined;
    const before = this.current.get(requestId);
    if (redirect && before) {
      this.answered(before, redirect);
      before.redirectedTo = url;
      before.ms = msBetween(before.started, params.timestamp);
    }
    const wall = Number(params.wallTime);
    const entry: Recorded = {
      id: this.next++,
      requestId,
      started: Number(params.timestamp ?? 0),
      at: Number.isFinite(wall) && wall > 0 ? Math.round(wall * 1000) : this.now(),
      method: String(request.method ?? "GET"),
      url,
      type: String(params.type ?? "other").toLowerCase(),
      requestHeaders: stringValues(request.headers),
      hasPostData: request.hasPostData === true || typeof request.postData === "string",
      ...(typeof request.postData === "string" ? { postData: request.postData } : {}),
    };
    this.current.set(requestId, entry);
    this.entries.push(entry);
    if (this.entries.length > NETWORK_LIMIT) {
      for (const gone of this.entries.splice(0, this.entries.length - NETWORK_LIMIT)) {
        if (this.current.get(gone.requestId) === gone) this.current.delete(gone.requestId);
      }
    }
  }

  private answered(entry: Recorded | undefined, response: Response | undefined): void {
    if (!entry || !response) return;
    entry.status = Number(response.status ?? 0);
    entry.statusText = String(response.statusText ?? "");
    if (typeof response.mimeType === "string" && response.mimeType !== "") {
      entry.mimeType = response.mimeType;
    }
    entry.responseHeaders = stringValues(response.headers);
    if (response.fromDiskCache === true || response.fromServiceWorker === true) {
      entry.cached = true;
    }
  }
}

interface Request {
  readonly url?: unknown;
  readonly method?: unknown;
  readonly headers?: unknown;
  readonly postData?: unknown;
  readonly hasPostData?: unknown;
}

interface Response {
  readonly status?: unknown;
  readonly statusText?: unknown;
  readonly mimeType?: unknown;
  readonly headers?: unknown;
  readonly fromDiskCache?: unknown;
  readonly fromServiceWorker?: unknown;
}

function msBetween(started: number, timestamp: unknown): number {
  const end = Number(timestamp);
  return Number.isFinite(end) && end >= started ? Math.round((end - started) * 1000) : 0;
}

function stringValues(headers: unknown): Record<string, string> {
  if (typeof headers !== "object" || headers === null) return {};
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
}

function publicEntry(entry: Recorded): NetworkEntry {
  const { requestId: _id, started: _started, ...rest } = entry;
  return { ...rest };
}

/** Whether a request failed: a network error, or an error status. */
export function requestFailed(entry: NetworkEntry): boolean {
  return entry.failure !== undefined || (entry.status !== undefined && entry.status >= 400);
}
