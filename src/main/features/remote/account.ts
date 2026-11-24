import os from "node:os";
import { z } from "zod";
import {
  BUG_REPORT_VERSION,
  type BugReport,
  type BugReportErrorArea,
  type PushSend,
  type ServerInfo,
  ServerInfoSchema,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import {
  type RemoteAccountState,
  type RemoteDeviceInfo,
  RemoteDeviceInfoSchema,
  RemoteUserSchema,
  type SignInFailure,
  type SignInProvider,
} from "../../../shared/remote/account";
import { ResponseTooLargeError, readResponseText } from "../../infra/http/body";
import type { RecordError } from "../../infra/recent-errors";
import { ServerError, SignedOutError, SignInError, UnreachableError } from "./errors";
import { type LoopbackListener, listenForCallback, notInvitedFailure } from "./loopback";
import { makePkce, makeState } from "./pkce";
import { retryAfterSeconds } from "./retry-after";
import { ServerRoute } from "./route";
import type { Kept } from "./sealed-file";

const log = createLogger("remote-account");

export { SignedOutError } from "./errors";

export const REQUEST_TIMEOUT_MS = 20_000;
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export const SavedAccountSchema = z.object({
  server: z.string(),
  token: z.string(),
  user: RemoteUserSchema,
  device: RemoteDeviceInfoSchema,
});
export type SavedAccount = z.infer<typeof SavedAccountSchema>;

const TokenResponseSchema = z.object({
  token: z.string().min(1),
  user: RemoteUserSchema,
  device: RemoteDeviceInfoSchema,
});

const DevicesResponseSchema = z.object({ devices: z.array(RemoteDeviceInfoSchema) });

export function thisDevice(): { name: string; platform: string } {
  const name =
    os
      .hostname()
      .replace(/\.local$/, "")
      .slice(0, 100) || "NexusCode";
  return { name, platform: process.platform };
}

export interface RemoteAccountDeps {
  readonly server: string;
  readonly proxy?: string | null;
  readonly direct?: string;
  readonly fallback?: string | null;
  now?: () => number;
  readonly store: Kept<SavedAccount>;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  onChange?(state: RemoteAccountState): void;
  device?: { name: string; platform: string };
  installId?: () => Promise<string | undefined>;
  listen?: (timeoutMs: number) => Promise<LoopbackListener>;
  onBrowserBack?(): void;
  timeoutMs?: number;
  provider?: SignInProvider;
  loginHint?: string;
  recordError?: RecordError;
}

export class RemoteAccount {
  private saved: SavedAccount | null = null;
  private startingSignIn = false;
  private signingIn: LoopbackListener | null = null;
  private recheckingToken: string | undefined;
  private failure: SignInFailure | undefined;
  private pendingProvider: SignInProvider | undefined;
  private readonly fetch: typeof fetch;
  readonly route: ServerRoute;

  constructor(private readonly deps: RemoteAccountDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.route = new ServerRoute(
      deps.direct ?? deps.server,
      deps.proxy ?? null,
      deps.now,
      deps.fallback ?? null,
    );
  }

  async restore(): Promise<void> {
    const saved = await this.deps.store.load();
    if (saved && saved.server === this.deps.server && !this.saved) {
      this.saved = saved;
      this.changed();
    }
  }

  state(): RemoteAccountState {
    const server = this.deps.server;
    if (this.saved) {
      return { status: "signed-in", server, user: this.saved.user, device: this.saved.device };
    }
    if (this.signingIn) return { status: "signing-in", server };
    return {
      status: "signed-out",
      server,
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.pendingProvider ? { provider: this.pendingProvider } : {}),
    };
  }

  token(): string | undefined {
    return this.saved?.token;
  }

  async signIn(provider?: SignInProvider): Promise<RemoteAccountState> {
    if (this.startingSignIn || this.signingIn || this.saved) return this.state();
    const choice = provider ?? this.pendingProvider ?? this.deps.provider ?? "google";
    this.startingSignIn = true;
    let listener: LoopbackListener;
    try {
      listener = await (this.deps.listen ?? listenForCallback)(
        this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      );
      this.signingIn = listener;
    } finally {
      this.startingSignIn = false;
    }
    this.failure = undefined;
    this.pendingProvider = undefined;
    this.changed();
    let signedIn = false;
    try {
      const { verifier, challenge } = makePkce();
      const state = makeState();
      const start = new URL(`/auth/${choice}/start`, this.route.direct);
      start.search = new URLSearchParams({
        redirect_uri: listener.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(this.deps.loginHint ? { login_hint: this.deps.loginHint } : {}),
      }).toString();
      await this.deps.openExternal(start.toString());
      const back = await listener.result;
      this.deps.onBrowserBack?.();
      if (back.state !== state) throw new SignInError("mismatch");
      if (back.failure) throw new SignInError(back.failure, back.error);
      if (!back.code) throw new SignInError("failed", "no code");
      const installId = await this.deps.installId?.().catch(() => undefined);
      const answer = await this.call("POST", "/auth/token", {
        body: {
          code: back.code,
          code_verifier: verifier,
          redirect_uri: listener.redirectUri,
          device: { ...(this.deps.device ?? thisDevice()), ...(installId ? { installId } : {}) },
        },
        signedIn: false,
      });
      const { token, user, device } = TokenResponseSchema.parse(answer);
      this.saved = { server: this.deps.server, token, user, device };
      signedIn = true;
      await this.deps.store.save(this.saved);
    } catch (error) {
      this.failure = failureOf(error);
      if (this.failure === "pending_approval") this.pendingProvider = choice;
      log.warn(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      listener.report(signedIn ? "signed-in" : (this.failure ?? "failed"), this.pendingProvider);
      listener.close();
      this.signingIn = null;
      this.changed();
    }
    return this.state();
  }

  cancelSignIn(): void {
    this.signingIn?.close();
  }

  async signOut(): Promise<void> {
    if (!this.saved) return;
    await this.call("POST", "/auth/logout").catch(() => {});
    this.forget();
  }

  recheckSignIn(): void {
    const token = this.token();
    if (!token || this.recheckingToken === token) return;
    this.recheckingToken = token;
    void this.request("GET", "/me")
      .catch(() => {})
      .finally(() => {
        if (this.recheckingToken === token) this.recheckingToken = undefined;
      });
  }

  async info(): Promise<ServerInfo> {
    return ServerInfoSchema.parse(await this.call("GET", "/info", { signedIn: false }));
  }

  async setDeviceAlias(id: string, alias: string | null): Promise<void> {
    const given = alias?.trim() || null;
    await this.call("PATCH", `/devices/${encodeURIComponent(id)}`, { body: { alias: given } });
    if (this.saved && id === this.saved.device.id) {
      this.saved = { ...this.saved, device: { ...this.saved.device, alias: given } };
      await this.deps.store.save(this.saved);
      this.changed();
    }
  }

  async syncDeviceName(): Promise<void> {
    const saved = this.saved;
    if (!saved) return;
    const name = (this.deps.device ?? thisDevice()).name;
    if (name === saved.device.name || name.trim().length < 1 || name.trim().length > 100) return;
    try {
      await this.call("PATCH", `/devices/${encodeURIComponent(saved.device.id)}`, {
        body: { name },
      });
      if (this.saved !== saved) return;
      this.saved = { ...saved, device: { ...saved.device, name } };
      await this.deps.store.save(this.saved);
      this.changed();
    } catch (error) {
      log.warn(`Device name not synced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteAccount(headers?: Record<string, string>): Promise<void> {
    await this.call("DELETE", "/account", headers ? { headers } : {});
    this.forget();
  }

  async devices(): Promise<RemoteDeviceInfo[]> {
    return DevicesResponseSchema.parse(await this.call("GET", "/devices")).devices;
  }

  async removeDevice(id: string): Promise<void> {
    await this.call("DELETE", `/devices/${encodeURIComponent(id)}`);
    if (id === this.saved?.device.id) this.forget();
  }

  sendPush(body: PushSend, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    return this.call("POST", "/push/send?v=1", {
      body,
      signal,
      timeoutMs,
      retryOrigin: false,
      area: "push",
    });
  }

  sendBugReport(body: BugReport): Promise<unknown> {
    return this.call("POST", `/bug-reports?v=${BUG_REPORT_VERSION}`, { body });
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.call(method, path, {
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
      signal,
    });
  }

  upload(
    path: string,
    bytes: Uint8Array,
    options: { type: string; headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<unknown> {
    return this.call("POST", path, {
      raw: { bytes, type: options.type, headers: options.headers ?? {} },
      timeoutMs: options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
    });
  }

  private async call(method: string, path: string, options: CallOptions = {}): Promise<unknown> {
    try {
      return await this.exchange(method, path, options);
    } catch (error) {
      if (!options.signal?.aborted) this.noteFailure(options.area ?? "api", error);
      throw error;
    }
  }

  private noteFailure(area: BugReportErrorArea, error: unknown): void {
    const record = this.deps.recordError;
    if (!record) return;
    if (error instanceof ServerError) {
      record(area, `http_${error.status}`, error.status, error.message);
    } else if (error instanceof SignedOutError && error.status !== undefined) {
      record(area, `http_${error.status}`, error.status, error.message);
    } else if (error instanceof UnreachableError) {
      record(area, error.timedOut ? "timeout" : "offline", undefined, error.message);
    } else if (isTimeout(error)) record(area, "timeout", undefined, (error as Error).message);
    else if (error instanceof TypeError) record(area, "offline", undefined, error.message);
  }

  private async exchange(method: string, path: string, options: CallOptions): Promise<unknown> {
    const { signal } = options;
    signal?.throwIfAborted();
    const headers: Record<string, string> = { ...options.raw?.headers, ...options.headers };
    let token: string | undefined;
    if (options.signedIn !== false) {
      if (!this.saved) throw new SignedOutError();
      token = this.saved.token;
      headers.authorization = `Bearer ${token}`;
    }
    const signedInAsSent = () => this.saved !== null && this.saved.token === token;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.raw) headers["content-type"] = options.raw.type;
    const body = options.raw
      ? options.raw.bytes
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
    const send = (base: string) => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      return this.fetch(this.route.url(path, { base }), {
        method,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(body !== undefined ? { body: body as NonNullable<RequestInit["body"]> } : {}),
      });
    };
    let base = this.route.base();
    const tried = [base];
    let res: Response;
    for (;;) {
      try {
        res = await send(base);
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (!this.route.unreachable(base) || options.retryOrigin === false || isTimeout(error)) {
          throw new UnreachableError(error);
        }
        base = this.route.base();
        if (tried.includes(base)) throw new UnreachableError(error);
        tried.push(base);
      }
    }
    signal?.throwIfAborted();
    if (res.status === 401 && options.signedIn !== false) {
      void res.body?.cancel().catch(() => {});
      if (signedInAsSent()) this.forget();
      throw new SignedOutError(401);
    }
    const retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
    const text = await readResponseText(res).catch((error: unknown) => {
      if (error instanceof ResponseTooLargeError) {
        throw new ServerError(res.status, error.code, `${method} ${path}`, retryAfter);
      }
      signal?.throwIfAborted();
      if (res.status === 429)
        throw new ServerError(res.status, undefined, `${method} ${path}`, retryAfter);
      if (options.retryOrigin === false) {
        if (!res.ok) throw new ServerError(res.status, undefined, `${method} ${path}`, retryAfter);
        if (error instanceof TypeError || isTimeout(error)) throw new UnreachableError(error);
      }
      throw error;
    });
    signal?.throwIfAborted();
    const answer = parseJson(text);
    if (!res.ok) {
      const refusal = isRecord(answer) ? answer : undefined;
      const code = typeof refusal?.error === "string" ? refusal.error : undefined;
      if (res.status === 403 && code === "not_invited" && options.signedIn !== false) {
        if (signedInAsSent()) {
          this.failure = refusal?.access === "suspended" ? "suspended" : "not_invited";
          this.forget();
        }
        throw new SignedOutError(403);
      }
      throw new ServerError(res.status, code, `${method} ${path}`, retryAfter, refusal?.access);
    }
    return answer ?? {};
  }

  private forget(): void {
    this.saved = null;
    this.deps.store.clear();
    this.changed();
  }

  private changed(): void {
    this.deps.onChange?.(this.state());
  }
}

interface CallOptions {
  body?: unknown;
  raw?: { bytes: Uint8Array; type: string; headers: Record<string, string> };
  headers?: Record<string, string>;
  signedIn?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  retryOrigin?: boolean;
  area?: BugReportErrorArea;
}

function failureOf(error: unknown): SignInFailure {
  if (error instanceof SignInError) return error.failure;
  if (error instanceof ServerError) {
    if (error.code === "invalid_grant") return "invalid_grant";
    if (error.status === 409 && error.code === "too_many_devices") return "too_many_devices";
    if (error.status === 429) return "rate_limited";
    if (error.status === 403 && error.code === "not_invited") {
      const failure = notInvitedFailure(error.access);
      return failure === "suspended" || failure === "not_invited" ? failure : "failed";
    }
    return "failed";
  }
  if (error instanceof UnreachableError) return "unreachable";
  return "failed";
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
