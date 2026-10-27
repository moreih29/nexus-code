/**
 * Electron's prefix on the rejection of an `invoke` whose main handler threw:
 * "Error invoking remote method 'ipc:call': <name>: <message>".
 */
const REMOTE_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:([A-Za-z]*Error(?:\[[^\]]*\])?): )?/;

/**
 * Restores the name and message main threw from Electron's rejection, so
 * callers that show the message show the error, not the IPC plumbing.
 */
export function unwrapRemoteError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const prefix = REMOTE_ERROR_PREFIX.exec(error.message);
  if (!prefix) return error;
  error.message = error.message.slice(prefix[0].length);
  if (prefix[1]) error.name = prefix[1];
  return error;
}
