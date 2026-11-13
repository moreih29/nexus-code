/** How the NexusCode server and a sign-in fail, as the app tells them apart. */
import type { SignInFailure } from "../../../shared/remote/account";

/** The server said the token is no good: it expired, or the device was removed. */
export class SignedOutError extends Error {
  constructor() {
    super("signed out of NexusCode");
  }
}

/** The server could not be reached, or did not answer in time. */
export class UnreachableError extends Error {
  constructor(cause: unknown) {
    super(`the NexusCode server did not answer: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/** The server answered with an error; `code` is its body's `error`, when it had one. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    what: string,
    /** How long the server asked to wait (Retry-After), in seconds. */
    readonly retryAfter?: number,
  ) {
    super(`${what}: ${status}${code ? ` ${code}` : ""}`);
  }
}

/** A sign-in that did not finish, and why. */
export class SignInError extends Error {
  constructor(
    readonly failure: SignInFailure,
    detail?: string,
  ) {
    super(`the sign-in did not finish: ${failure}${detail ? ` (${detail})` : ""}`);
  }
}
