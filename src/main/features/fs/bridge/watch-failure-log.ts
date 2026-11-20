import { errorText, type LimitedLogger, shortId } from "../../../../shared/log/limit";
import { redactLogSecrets } from "../../../../shared/log/redact-secrets";

/**
 * A failure that only means the connection was already going away: the agent's
 * channel was disposed, or the call aborted with it. It is expected while a
 * workspace closes, and says nothing a reader can act on.
 */
export function isTeardownFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /channel disposed|AbortError|is closing|is disposed/i.test(text);
}

/**
 * Logs a failed watch call: a warn, or a debug when the connection was going
 * away, once a minute per kind and workspace. The line has the workspace's first
 * 8 characters, never a path, and the error text without paths.
 */
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
