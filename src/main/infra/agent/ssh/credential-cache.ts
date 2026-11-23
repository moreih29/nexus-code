import type { SshAuthPrompt, SshAuthResponse } from "../../../../shared/ssh/auth-prompt";
import type { SshAuthPromptHandler } from "./auth-pty";

function credentialKey(prompt: Extract<SshAuthPrompt, { kind: "password" }>): string {
  return `${prompt.host}|${prompt.username ?? ""}|${prompt.port ?? 22}|${prompt.field}|${prompt.prompt}`;
}

export function createCachingAuthPromptHandler(inner: SshAuthPromptHandler): SshAuthPromptHandler {
  const cache = new Map<string, string>();

  return async function cachingAuthPromptHandler(
    prompt: SshAuthPrompt,
    signal?: AbortSignal,
  ): Promise<SshAuthResponse> {
    signal?.throwIfAborted();
    if (prompt.kind !== "password") {
      return inner(prompt, signal);
    }

    const key = credentialKey(prompt);

    if (prompt.retry) {
      cache.delete(key);
    } else {
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { kind: "password", promptId: prompt.promptId, value: cached };
      }
    }

    const response = await inner(prompt, signal);
    if (response.kind === "password" && response.value) {
      cache.set(key, response.value);
    }
    return response;
  };
}
