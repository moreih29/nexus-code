import { errorText, type LimitedLogger, shortId } from "../../../../shared/log/limit";
import { redactLogSecrets } from "../../../../shared/log/redact-secrets";

export function isTeardownFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /channel disposed|AbortError|is closing|is disposed/i.test(text);
}

export function reportWatchFailure(
  limited: LimitedLogger,
  what: string,
  workspaceId: string | null,
  error: unknown,
): void {
  const workspace = workspaceId === null ? "" : ` (workspace=${shortId(workspaceId)})`;
  limited.log(
    isTeardownFailure(error) ? "debug" : "warn",
    `${what}:${workspaceId === null ? "" : shortId(workspaceId)}`,
    `${what} failed${workspace}: ${errorText(error, 200, redactLogSecrets)}`,
  );
}
