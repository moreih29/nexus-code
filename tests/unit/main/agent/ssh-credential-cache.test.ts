/**
 * ssh-credential-cache.test.ts
 *
 * Unit tests for Fix 1: session-scoped credential caching decorator.
 *
 * RED phase: verifies desired behavior that is not yet implemented —
 * the tests will fail until createCachingAuthPromptHandler exists.
 *
 * GREEN phase: all assertions pass after the implementation is in place.
 */

import { describe, expect, it, mock } from "bun:test";
import { createCachingAuthPromptHandler } from "../../../../src/main/infra/agent/ssh/credential-cache";
import type { SshAuthPrompt, SshAuthResponse } from "../../../../src/shared/ssh/auth-prompt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passwordPrompt(opts: {
  host: string;
  username?: string;
  port?: number;
  retry?: boolean;
}): SshAuthPrompt {
  return {
    kind: "password",
    promptId: `${opts.host}:password`,
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username ?? "alice",
    prompt: `${opts.username ?? "alice"}@${opts.host}'s password:`,
    field: "password",
    retry: opts.retry,
  };
}

function hostKeyPrompt(host: string): SshAuthPrompt {
  return {
    kind: "host-key",
    promptId: `${host}:host-key`,
    host,
    port: 22,
    keyType: "ED25519",
    fingerprint: "SHA256:abc123",
    message: "The authenticity of the host can't be established.",
  };
}

function passwordResponse(promptId: string, value: string): SshAuthResponse {
  return { kind: "password", promptId, value };
}

// ---------------------------------------------------------------------------
// (A) Cache hit: second auth call for same host/user skips inner promptHandler
// ---------------------------------------------------------------------------

describe("createCachingAuthPromptHandler — cache hit", () => {
  it("does NOT call inner promptHandler on second auth for same host+user", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, "secret123");
    });

    const handler = createCachingAuthPromptHandler(inner);

    // First auth: inner must be called, password stored.
    const firstPrompt = passwordPrompt({ host: "example.com", username: "alice" });
    const firstResult = await handler(firstPrompt);
    expect(firstResult).toEqual(passwordResponse(firstPrompt.promptId, "secret123"));
    expect(innerCalls).toHaveLength(1);

    // Second auth for the same host+user: inner must NOT be called.
    const secondPrompt = passwordPrompt({ host: "example.com", username: "alice" });
    const secondResult = await handler(secondPrompt);
    expect(secondResult).toEqual(passwordResponse(secondPrompt.promptId, "secret123"));
    // Inner should still be 1 — no new call for the cached credential.
    expect(innerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (B) Cache invalidation: retry=true prompt evicts cached entry and falls back to inner
// ---------------------------------------------------------------------------

describe("createCachingAuthPromptHandler — auto-invalidation on retry", () => {
  it("evicts cached password when SSH signals retry=true (wrong password) and calls inner", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    let callIdx = 0;
    const passwords = ["wrong-secret", "correct-secret"];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, passwords[callIdx++] ?? "fallback");
    });

    const handler = createCachingAuthPromptHandler(inner);

    // First auth: caches "wrong-secret".
    await handler(passwordPrompt({ host: "host.test", username: "bob" }));
    expect(innerCalls).toHaveLength(1);

    // Cache hit for second normal prompt: inner not called.
    await handler(passwordPrompt({ host: "host.test", username: "bob" }));
    expect(innerCalls).toHaveLength(1);

    // SSH reports "Permission denied, please try again" → retry=true prompt.
    // The cached credential is wrong, so the handler must evict it and call inner.
    const retryPrompt = passwordPrompt({ host: "host.test", username: "bob", retry: true });
    const result = await handler(retryPrompt);
    expect(result).toEqual(passwordResponse(retryPrompt.promptId, "correct-secret"));
    // Inner must have been called for the retry.
    expect(innerCalls).toHaveLength(2);
  });

  it("after retry-eviction, next non-retry prompt hits the new cached value", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    let callIdx = 0;
    const passwords = ["old", "new"];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, passwords[callIdx++] ?? "fallback");
    });

    const handler = createCachingAuthPromptHandler(inner);

    // Seed with "old".
    await handler(passwordPrompt({ host: "srv.example", username: "carol" }));
    expect(innerCalls).toHaveLength(1);

    // Retry evicts "old", caches "new".
    await handler(passwordPrompt({ host: "srv.example", username: "carol", retry: true }));
    expect(innerCalls).toHaveLength(2);

    // Next non-retry: should hit "new" from cache without calling inner.
    const result = await handler(passwordPrompt({ host: "srv.example", username: "carol" }));
    expect(result).toEqual(
      passwordResponse(`srv.example:password`, "new"),
    );
    expect(innerCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (C) Host-key prompts are never cached
// ---------------------------------------------------------------------------

describe("createCachingAuthPromptHandler — host-key not cached", () => {
  it("always forwards host-key prompts to inner and stores nothing", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
    });

    const handler = createCachingAuthPromptHandler(inner);

    await handler(hostKeyPrompt("hk.example.com"));
    await handler(hostKeyPrompt("hk.example.com"));
    // Both calls must reach inner — host-key is never cached.
    expect(innerCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (D) Different host/user pairs are cached independently
// ---------------------------------------------------------------------------

describe("createCachingAuthPromptHandler — key isolation", () => {
  it("caches credentials per host+user+port independently", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    let callIdx = 0;
    const passwords = ["pw-alice", "pw-bob"];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, passwords[callIdx++] ?? "fallback");
    });

    const handler = createCachingAuthPromptHandler(inner);

    await handler(passwordPrompt({ host: "h1.example", username: "alice" }));
    await handler(passwordPrompt({ host: "h1.example", username: "bob" }));
    // Two different users on same host → two inner calls.
    expect(innerCalls).toHaveLength(2);

    // Third call is alice on h1 — should hit cache, no new inner call.
    await handler(passwordPrompt({ host: "h1.example", username: "alice" }));
    expect(innerCalls).toHaveLength(2);

    // Fourth call is bob on h1 — should hit cache, no new inner call.
    await handler(passwordPrompt({ host: "h1.example", username: "bob" }));
    expect(innerCalls).toHaveLength(2);
  });

  it("same user on different hosts are cached separately", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, "secret");
    });

    const handler = createCachingAuthPromptHandler(inner);

    await handler(passwordPrompt({ host: "h1.example", username: "alice" }));
    await handler(passwordPrompt({ host: "h2.example", username: "alice" }));
    // Different hosts → two inner calls.
    expect(innerCalls).toHaveLength(2);
  });
});
