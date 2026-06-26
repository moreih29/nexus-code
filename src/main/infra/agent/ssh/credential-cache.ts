import type { SshAuthPrompt, SshAuthResponse } from "../../../../shared/ssh/auth-prompt";
import type { SshAuthPromptHandler } from "./auth-pty";

/** Builds the cache key from SSH connection identity fields. */
function credentialKey(host: string, user: string | undefined, port: number | undefined): string {
  return `${host}|${user ?? ""}|${port ?? 22}`;
}

/**
 * Wraps an SSH auth prompt handler with session-scoped (in-memory only)
 * password caching.
 *
 * Behaviour:
 *  - Password prompts (retry=false/undefined): on cache hit, returns the
 *    stored credential without calling `inner`. On miss, calls `inner` and
 *    stores the returned password.
 *  - Password prompts (retry=true): SSH has signalled "Permission denied,
 *    please try again" — the cached credential was wrong. The entry for this
 *    host+user is evicted before calling `inner`, so the user is prompted for
 *    a fresh password which then re-populates the cache.
 *  - Host-key prompts: always forwarded to `inner`; never cached.
 *
 * No disk or keychain I/O; the cache is scoped to the app process lifetime.
 */
export function createCachingAuthPromptHandler(inner: SshAuthPromptHandler): SshAuthPromptHandler {
  const cache = new Map<string, string>();

  return async function cachingAuthPromptHandler(
    prompt: SshAuthPrompt,
  ): Promise<SshAuthResponse> {
    // Host-key prompts are never cached — always ask the user.
    if (prompt.kind !== "password") {
      return inner(prompt);
    }

    const key = credentialKey(prompt.host, prompt.username, prompt.port);

    // retry=true means the previous password (possibly cached) was rejected.
    // Evict the stale entry so the user is asked again.
    if (prompt.retry) {
      cache.delete(key);
    } else {
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { kind: "password", promptId: prompt.promptId, value: cached };
      }
    }

    const response = await inner(prompt);
    if (response.kind === "password" && response.value) {
      cache.set(key, response.value);
    }
    return response;
  };
}
