/** Retry-After is a delay in seconds or an HTTP date. */
export function retryAfterSeconds(header: string | null | undefined): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:, | )/i.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}

const MAX_SOCKET_RETRY_MS = 5 * 60_000;

/** A server-requested pause shared by ticket requests and socket upgrades. */
export class SocketRetryAfter {
  private until = 0;

  constructor(private readonly now = () => performance.now()) {}

  pause(seconds: number): void {
    this.until = Math.max(this.until, this.now() + Math.min(MAX_SOCKET_RETRY_MS, seconds * 1000));
  }

  remaining(): number {
    return Math.max(0, this.until - this.now());
  }
}
