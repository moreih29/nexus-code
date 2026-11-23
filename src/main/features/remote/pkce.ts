import { createHash, randomBytes } from "node:crypto";

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeOf(verifier) };
}

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function makeState(): string {
  return randomBytes(16).toString("base64url");
}
