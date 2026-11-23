import { createLogger } from "../../../shared/log/main";

const log = createLogger("remote-route");

export const PROXY_DOWN_MS = 5 * 60_000;

export const RETURN_CHECK_MS = 60_000;

const RETURN_PROBE_TIMEOUT_MS = 5_000;

interface Way {
  readonly name: "proxy" | "direct" | "fallback";
  readonly address: string;
  downUntil: number;
}

export class ServerRoute {
  private readonly ways: readonly Way[];

  constructor(
    readonly direct: string,
    readonly proxy: string | null = null,
    private readonly now: () => number = Date.now,
    readonly fallback: string | null = null,
  ) {
    const way = (name: Way["name"], address: string | null): Way[] =>
      address === null ? [] : [{ name, address, downUntil: 0 }];
    this.ways = [...way("proxy", proxy), ...way("direct", direct), ...way("fallback", fallback)];
  }

  base(): string {
    const now = this.now();
    return this.ways.find((way) => now >= way.downUntil)?.address ?? this.direct;
  }

  url(path: string, options: { socket?: boolean; base?: string } = {}): URL {
    const url = new URL(path, options.base ?? this.base());
    if (options.socket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

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

  backFrom(address: string): string | null {
    const base = this.base();
    return this.wayOf(address) > this.wayOf(base) ? base : null;
  }

  private wayOf(address: string): number {
    return this.ways.findIndex((way) => sameHost(address, way.address));
  }
}

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

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
