/**
 * The app's NexusCode account: signing in with Google through the system
 * browser (OAuth with PKCE and a loopback redirect, as RFC 8252 has it for
 * a desktop app), the server's session token it gets for this device, and
 * the account's devices. The token is what the relay and the API take.
 */

import os from "node:os";
import { z } from "zod";
import {
  type RemoteAccountState,
  type RemoteDeviceInfo,
  RemoteDeviceInfoSchema,
  RemoteUserSchema,
  type SignInFailure,
} from "../../../shared/remote/account";
import { ServerError, SignedOutError, SignInError, UnreachableError } from "./errors";
import { type LoopbackListener, listenForCallback } from "./loopback";
import { makePkce, makeState } from "./pkce";
import type { Kept } from "./sealed-file";

export { SignedOutError } from "./errors";

/** How long a call to the server may take. */
export const REQUEST_TIMEOUT_MS = 20_000;

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
  /** The server's address, e.g. http://localhost:8787. */
  readonly server: string;
  readonly store: Kept<SavedAccount>;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Told each time the state changes. */
  onChange?(state: RemoteAccountState): void;
  /** This device as the server should name it. */
  device?: { name: string; platform: string };
  listen?: (timeoutMs: number) => Promise<LoopbackListener>;
  timeoutMs?: number;
  /**
   * Who signs the user in: Google, or the dev server's own sign-in (only on
   * a server at localhost), which takes an email and no password.
   */
  provider?: "google" | "dev";
  /** The email to sign in as, when known: the dev sign-in then asks nothing. */
  loginHint?: string;
}

export class RemoteAccount {
  private saved: SavedAccount | null = null;
  private signingIn: LoopbackListener | null = null;
  /** Why the last sign-in failed, until the next one starts. */
  private failure: SignInFailure | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: RemoteAccountDeps) {
    this.fetch = deps.fetch ?? fetch;
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
   * Opens the server's Google sign-in in the browser and waits for it to
   * come back; then trades its code for this device's token. A sign-in that
   * does not finish leaves the app signed out, with why in the state.
   */
  async signIn(): Promise<RemoteAccountState> {
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
      const start = new URL(`/auth/${this.deps.provider ?? "google"}/start`, this.deps.server);
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
      const answer = await this.call("POST", "/auth/token", {
        body: {
          code: back.code,
          code_verifier: verifier,
          redirect_uri: listener.redirectUri,
          device: this.deps.device ?? thisDevice(),
        },
        signedIn: false,
      });
      const { token, user, device } = TokenResponseSchema.parse(answer);
      this.saved = { server: this.deps.server, token, user, device };
      await this.deps.store.save(this.saved);
    } catch (error) {
      this.failure = failureOf(error);
      console.warn("[remote] sign-in failed:", error instanceof Error ? error.message : error);
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

  /**
   * Deletes the account on the server: its devices, its key bundle, all
   * of it. Every device is signed out; this one forgets its sign-in.
   */
  async deleteAccount(): Promise<void> {
    await this.call("DELETE", "/account");
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
   * a 401 signs the app out and throws SignedOutError.
   */
  request(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.call(method, path, body === undefined ? {} : { body });
  }

  /** Asks the server, signed in unless told not to; a 401 signs the app out. */
  private async call(
    method: string,
    path: string,
    options: { body?: unknown; signedIn?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options.signedIn !== false) {
      if (!this.saved) throw new SignedOutError();
      headers.authorization = `Bearer ${this.saved.token}`;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(new URL(path, this.deps.server), {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      // fetch fails with a TypeError when the server cannot be reached, a TimeoutError when it is slow.
      throw new UnreachableError(error);
    }
    if (res.status === 401 && options.signedIn !== false) {
      this.forget();
      throw new SignedOutError();
    }
    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok) {
      const code = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ServerError(
        res.status,
        code,
        `${method} ${path}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return body ?? {};
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
  if (error instanceof ServerError)
    return error.code === "invalid_grant" ? "invalid_grant" : "failed";
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
