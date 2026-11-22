/**
 * How requests reach the NexusCode server: by the first of its ways that did
 * not fail lately. The proxy comes first when there is one (the server's own
 * addresses are slow or blocked on some networks), then the server's own
 * address, then a fallback when there is one. The server stays the one
 * signed in to; the ways only carry requests to it. A way that cannot be
 * reached is passed by for PROXY_DOWN_MS, then tried again; the last is
 * never passed by.
 */

import { createLogger } from "../../../shared/log/main";

const log = createLogger("remote-route");

/** How long requests pass a way by once it could not be reached. */
export const PROXY_DOWN_MS = 5 * 60_000;

/** How often a socket on a later way looks whether it can go back to an earlier one. */
export const RETURN_CHECK_MS = 60_000;

/** How long a way has to answer, asked whether a socket may go back to it. */
const RETURN_PROBE_TIMEOUT_MS = 5_000;

interface Way {
  readonly name: "proxy" | "direct" | "fallback";
  readonly address: string;
  downUntil: number;
}

export class ServerRoute {
  /** The ways in the order requests try them. */
  private readonly ways: readonly Way[];

  constructor(
    /** The server's own address: gone to straight, and where its sign-in opens. */
    readonly direct: string,
    /** The proxy requests go through first; none to go straight first. */
    readonly proxy: string | null = null,
    private readonly now: () => number = Date.now,
    /** Where requests go when neither above can be reached; none to stop at `direct`. */
    readonly fallback: string | null = null,
  ) {
    const way = (name: Way["name"], address: string | null): Way[] =>
      address === null ? [] : [{ name, address, downUntil: 0 }];
    this.ways = [...way("proxy", proxy), ...way("direct", direct), ...way("fallback", fallback)];
  }

  /** Where requests go now: the first way that did not fail lately. */
  base(): string {
    const now = this.now();
    // The last way is never passed by, so there is always one.
    return this.ways.find((way) => now >= way.downUntil)?.address ?? this.direct;
  }

  /** `path` at `base` (where requests go now by default), as a websocket's address when `socket`. */
  url(path: string, options: { socket?: boolean; base?: string } = {}): URL {
    const url = new URL(path, options.base ?? this.base());
    if (options.socket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  /**
   * A request to `address` did not reach it. When that was a way with another
   * after it, requests pass it by for a while; true then, so the caller may
   * try again by the next.
   */
  unreachable(address: string): boolean {
    const at = this.wayOf(address);
    const way = this.ways[at];
    if (way === undefined || at === this.ways.length - 1) return false;
    if (this.now() >= way.downUntil) {
      log.warn(`The ${way.name} route could not be reached, using the next one.`);
    }
    way.downUntil = this.now() + PROXY_DOWN_MS;
    return true;
  }

  /**
   * Where a socket open at `address` could go back to: the way requests go
   * by now, when it comes before the socket's. Null when the socket is on it
   * already, or on none of the ways.
   */
  backFrom(address: string): string | null {
    const base = this.base();
    return this.wayOf(address) > this.wayOf(base) ? base : null;
  }

  /** Which way `address` is on, by its host; -1 for none. */
  private wayOf(address: string): number {
    return this.ways.findIndex((way) => sameHost(address, way.address));
  }
}

/**
 * Checks whether a socket on a later way (straight, or the fallback) can go
 * back to the way requests go by now, after a full interval. The result
 * belongs to the open socket and route that initiated the probe.
 */
export function returnToProxy(options: {
  route: ServerRoute;
  via: () => { readonly origin: string; readonly openedAt: number } | null;
  reconnect: () => void;
  fetch?: typeof fetch;
  now?: () => number;
}): { check(): Promise<void>; stop(): void } {
  const { route } = options;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const lifetime = new AbortController();
  let asking = false;

  /** Probes the way requests go by now while the current socket is open on a later one. */
  async function check(): Promise<void> {
    if (lifetime.signal.aborted || asking) return;
    const connection = options.via();
    if (connection === null || now() - connection.openedAt < RETURN_CHECK_MS) return;
    const back = route.backFrom(connection.origin);
    if (back === null) return;

    asking = true;
    let reachable: boolean;
    try {
      const res = await fetchFn(new URL("/info", back), {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(RETURN_PROBE_TIMEOUT_MS)]),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    } finally {
      asking = false;
    }

    if (lifetime.signal.aborted || options.via() !== connection || route.base() !== back) return;
    if (reachable) options.reconnect();
    else route.unreachable(back);
  }

  const timer = setInterval(() => void check(), RETURN_CHECK_MS);
  timer.unref?.();
  return {
    check,
    stop() {
      clearInterval(timer);
      lifetime.abort();
    },
  };
}

/** Whether two addresses are of one host, a websocket's (wss:) and its https: alike. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
