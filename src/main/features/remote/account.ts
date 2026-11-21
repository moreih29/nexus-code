/**
 * The app's NexusCode account: signing in through the system browser
 * (OAuth with PKCE and a loopback redirect, as RFC 8252 has it for a
 * desktop app), the server's session token it gets for this
 * device, and the account's devices. The token is what the relay and the
 * API take. Requests go by its route: through the proxy when there is one,
 * the server straight when it cannot be reached.
 */

import os from "node:os";
import { z } from "zod";
import { type ServerInfo, ServerInfoSchema } from "../../../../packages/remote-protocol/src";
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
import { ServerError, SignedOutError, SignInError, UnreachableError } from "./errors";
import { type LoopbackListener, listenForCallback } from "./loopback";
import { makePkce, makeState } from "./pkce";
import { ServerRoute } from "./route";
import type { Kept } from "./sealed-file";

const log = createLogger("remote-account");

export { SignedOutError } from "./errors";

/** How long a call to the server may take. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** How long sending a file may take (a recording of hours is tens of MB). */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** How long the browser has to come back: the server gives a sign-in 10 minutes. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The sign-in as the app keeps it, sealed. */
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

/** What the server sends the browser back with, besides a code. */
const CALLBACK_ERRORS: readonly SignInFailure[] = [
  "access_denied",
  "unverified_email",
  "not_invited",
  "server_error",
];

/** This device as the server should name it: up to 100 characters, a lowercase platform. */
export function thisDevice(): { name: string; platform: string } {
  const name =
    os
      .hostname()
      .replace(/\.local$/, "")
      .slice(0, 100) || "NexusCode";
  return { name, platform: process.platform };
}

export interface RemoteAccountDeps {
  /** The server's address, e.g. http://localhost:8787: the one signed in to. */
  readonly server: string;
  /** The proxy requests to the server go through; none to go straight. */
  readonly proxy?: string | null;
  /** The time now, for how long the proxy stays passed by. */
  now?: () => number;
  readonly store: Kept<SavedAccount>;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Told each time the state changes. */
  onChange?(state: RemoteAccountState): void;
  /** This device as the server should name it. */
  device?: { name: string; platform: string };
  /** This install's id, sent with a sign-in so the server gives the same device back. */
  installId?: () => Promise<string | undefined>;
  listen?: (timeoutMs: number) => Promise<LoopbackListener>;
  timeoutMs?: number;
  /** The sign-in used when none is asked for. */
  provider?: SignInProvider;
  /** The email to sign in as, when known: the dev sign-in then asks nothing. */
  loginHint?: string;
}

export class RemoteAccount {
  private saved: SavedAccount | null = null;
  private signingIn: LoopbackListener | null = null;
  /** Why the last sign-in failed, until the next one starts. */
  private failure: SignInFailure | undefined;
  private readonly fetch: typeof fetch;
  /** How requests reach the server; the relay's and voice input's sockets go by it too. */
  readonly route: ServerRoute;

  constructor(private readonly deps: RemoteAccountDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.route = new ServerRoute(deps.server, deps.proxy ?? null, deps.now);
  }

  /** Picks up the sign-in kept from the last run, if there is one for this server. */
  async restore(): Promise<void> {
    const saved = await this.deps.store.load();
    // A sign-in to another server is not this one's.
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
    return { status: "signed-out", server, ...(this.failure ? { failure: this.failure } : {}) };
  }

  /** The session token, while signed in. */
  token(): string | undefined {
    return this.saved?.token;
  }

  /**
   * Opens the server's sign-in (Google's unless told) in the browser and
   * waits for it to come back; then trades its code for this device's
   * token. A sign-in that does not finish leaves the app signed out, with
   * why in the state.
   */
  async signIn(provider?: SignInProvider): Promise<RemoteAccountState> {
    if (this.signingIn || this.saved) return this.state();
    const listener = await (this.deps.listen ?? listenForCallback)(
      this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );
    this.signingIn = listener;
    this.failure = undefined;
    this.changed();
    try {
      const { verifier, challenge } = makePkce();
      const state = makeState();
      const start = new URL(
        `/auth/${provider ?? this.deps.provider ?? "google"}/start`,
        this.deps.server,
      );
      start.search = new URLSearchParams({
        redirect_uri: listener.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(this.deps.loginHint ? { login_hint: this.deps.loginHint } : {}),
      }).toString();
      await this.deps.openExternal(start.toString());
      const back = await listener.result;
      if (back.state !== state) throw new SignInError("mismatch");
      if (back.error) {
        const failure = CALLBACK_ERRORS.find((e) => e === back.error);
        throw new SignInError(failure ?? "failed", back.error);
      }
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
      await this.deps.store.save(this.saved);
    } catch (error) {
      this.failure = failureOf(error);
      log.warn(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      listener.close();
      this.signingIn = null;
      this.changed();
    }
    return this.state();
  }

  /** Stops a sign-in waiting on the browser. */
  cancelSignIn(): void {
    this.signingIn?.close();
  }

  /** Ends this device's session on the server, and forgets it here either way. */
  async signOut(): Promise<void> {
    if (!this.saved) return;
    await this.call("POST", "/auth/logout").catch(() => {});
    this.forget();
  }

  /** What the server offers: its sign-ins, and whether it has the relay and voice. */
  async info(): Promise<ServerInfo> {
    return ServerInfoSchema.parse(await this.call("GET", "/info", { signedIn: false }));
  }

  /**
   * Gives a device of the account an alias, shown in place of the name it
   * signed in with, or takes it away (null or empty); the room tells every
   * device.
   */
  async setDeviceAlias(id: string, alias: string | null): Promise<void> {
    const given = alias?.trim() || null;
    await this.call("PATCH", `/devices/${encodeURIComponent(id)}`, { body: { alias: given } });
    if (this.saved && id === this.saved.device.id) {
      this.saved = { ...this.saved, device: { ...this.saved.device, alias: given } };
      await this.deps.store.save(this.saved);
      this.changed();
    }
  }

  /**
   * Tells the server this machine's name when it is not the one kept from
   * sign-in (the PC was renamed since). Never throws: a request that fails
   * leaves the kept name, so the next run asks again.
   */
  async syncDeviceName(): Promise<void> {
    const saved = this.saved;
    if (!saved) return;
    const name = (this.deps.device ?? thisDevice()).name;
    if (name === saved.device.name || name.trim().length < 1 || name.trim().length > 100) return;
    try {
      await this.call("PATCH", `/devices/${encodeURIComponent(saved.device.id)}`, {
        body: { name },
      });
      // Signed out, or in as another device, while the request was away.
      if (this.saved !== saved) return;
      this.saved = { ...saved, device: { ...saved.device, name } };
      await this.deps.store.save(this.saved);
      this.changed();
    } catch (error) {
      log.warn(`Device name not synced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Deletes the account on the server: its devices, its key bundle, all
   * of it. Every device is signed out; this one forgets its sign-in.
   */
  async deleteAccount(headers?: Record<string, string>): Promise<void> {
    await this.call("DELETE", "/account", headers ? { headers } : {});
    this.forget();
  }

  async devices(): Promise<RemoteDeviceInfo[]> {
    return DevicesResponseSchema.parse(await this.call("GET", "/devices")).devices;
  }

  /** Removes a device from the account; removing this one signs it out. */
  async removeDevice(id: string): Promise<void> {
    await this.call("DELETE", `/devices/${encodeURIComponent(id)}`);
    if (id === this.saved?.device.id) this.forget();
  }

  /**
   * Asks the server as this device: the JSON it answered, or a ServerError;
   * a 401 signs the app out and throws SignedOutError. `headers` adds to the
   * request's own (the account password's proof, say). An aborted request
   * cannot update the route or sign the account out.
   */
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

  /**
   * Sends bytes to the server as this device (a recording, say): the JSON
   * it answered, or a ServerError; a 401 signs the app out.
   */
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

  /** Asks the server, signed in unless told not to; a 401 signs the app out. */
  private async call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      raw?: { bytes: Uint8Array; type: string; headers: Record<string, string> };
      headers?: Record<string, string>;
      signedIn?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const { signal } = options;
    signal?.throwIfAborted();
    const headers: Record<string, string> = { ...options.raw?.headers, ...options.headers };
    if (options.signedIn !== false) {
      if (!this.saved) throw new SignedOutError();
      headers.authorization = `Bearer ${this.saved.token}`;
    }
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
    const base = this.route.base();
    let res: Response;
    try {
      res = await send(base);
    } catch (error) {
      signal?.throwIfAborted();
      // fetch fails with a TypeError when the server cannot be reached, a TimeoutError when it
      // is slow. The proxy not reached, the server is asked straight, now and for a while; a
      // request that timed out may have gone through, and is not sent again.
      if (!this.route.unreachable(base) || isTimeout(error)) throw new UnreachableError(error);
      try {
        res = await send(this.route.base());
      } catch (again) {
        signal?.throwIfAborted();
        throw new UnreachableError(again);
      }
    }
    // A stale relay ticket can no longer change the account or its route.
    signal?.throwIfAborted();
    if (res.status === 401 && options.signedIn !== false) {
      void res.body?.cancel().catch(() => {});
      this.forget();
      throw new SignedOutError();
    }
    const text = await readResponseText(res).catch((error: unknown) => {
      if (error instanceof ResponseTooLargeError) {
        throw new ServerError(res.status, error.code, `${method} ${path}`);
      }
      throw error;
    });
    signal?.throwIfAborted();
    const answer = parseJson(text);
    if (!res.ok) {
      const code = isRecord(answer) && typeof answer.error === "string" ? answer.error : undefined;
      // An account taken off an invite-only server's list: signed out as by a
      // 401, saying why.
      if (res.status === 403 && code === "not_invited" && options.signedIn !== false) {
        this.failure = "not_invited";
        this.forget();
        throw new SignedOutError();
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ServerError(
        res.status,
        code,
        `${method} ${path}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
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

function failureOf(error: unknown): SignInFailure {
  if (error instanceof SignInError) return error.failure;
  if (error instanceof ServerError) {
    if (error.code === "invalid_grant") return "invalid_grant";
    if (error.status === 409 && error.code === "too_many_devices") return "too_many_devices";
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

/** A fetch that gave up waiting (AbortSignal.timeout), rather than one that reached nothing. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
