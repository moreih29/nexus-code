import type { SignInFailure } from "../../../shared/remote/account";

export class SignedOutError extends Error {
  constructor(readonly status?: number) {
    super("signed out of NexusCode");
  }
}

export class OutdatedError extends Error {
  constructor() {
    super("the NexusCode server no longer takes this version of the app");
  }
}

export class UnreachableError extends Error {
  readonly timedOut: boolean;

  constructor(cause: unknown) {
    super(`the NexusCode server did not answer: ${cause instanceof Error ? cause.message : cause}`);
    this.timedOut = cause instanceof Error && cause.name === "TimeoutError";
  }
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    what: string,
    readonly retryAfter?: number,
    readonly access?: unknown,
  ) {
    super(`${what}: ${status}${code ? ` ${code}` : ""}`);
  }
}

export class SignInError extends Error {
  constructor(
    readonly failure: SignInFailure,
    detail?: string,
  ) {
    super(`the sign-in did not finish: ${failure}${detail ? ` (${detail})` : ""}`);
  }
}
