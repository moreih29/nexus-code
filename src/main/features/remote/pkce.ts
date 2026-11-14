/** OAuth's PKCE (RFC 7636) and state values for the app's sign-in. */

import { createHash, randomBytes } from "node:crypto";

/** A verifier the app keeps and the challenge (S256) it sends ahead of it. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeOf(verifier) };
}

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The state that ties the browser's return to this sign-in. */
export function makeState(): string {
  return randomBytes(16).toString("base64url");
}
