import { describe, expect, it, mock } from "bun:test";
import { createCachingAuthPromptHandler } from "../../../../src/main/infra/agent/ssh/credential-cache";
import type { SshAuthPrompt, SshAuthResponse } from "../../../../src/shared/ssh/auth-prompt";

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

describe("createCachingAuthPromptHandler — cache hit", () => {
  it("does NOT call inner promptHandler on second auth for same host+user", async () => {
    const innerCalls: SshAuthPrompt[] = [];
    const inner = mock(async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      innerCalls.push(prompt);
      return passwordResponse(prompt.promptId, "secret123");
    });

    const handler = createCachingAuthPromptHandler(inner);

    const firstPrompt = passwordPrompt({ host: "example.com", username: "alice" });
    const firstResult = await handler(firstPrompt);
    expect(firstResult).toEqual(passwordResponse(firstPrompt.promptId, "secret123"));
    expect(innerCalls).toHaveLength(1);

    const secondPrompt = passwordPrompt({ host: "example.com", username: "alice" });
    const secondResult = await handler(secondPrompt);
    expect(secondResult).toEqual(passwordResponse(secondPrompt.promptId, "secret123"));
    expect(innerCalls).toHaveLength(1);
  });
});

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

    await handler(passwordPrompt({ host: "host.test", username: "bob" }));
    expect(innerCalls).toHaveLength(1);

    await handler(passwordPrompt({ host: "host.test", username: "bob" }));
    expect(innerCalls).toHaveLength(1);

    const retryPrompt = passwordPrompt({ host: "host.test", username: "bob", retry: true });
    const result = await handler(retryPrompt);
    expect(result).toEqual(passwordResponse(retryPrompt.promptId, "correct-secret"));
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

    await handler(passwordPrompt({ host: "srv.example", username: "carol" }));
    expect(innerCalls).toHaveLength(1);

    await handler(passwordPrompt({ host: "srv.example", username: "carol", retry: true }));
    expect(innerCalls).toHaveLength(2);

    const result = await handler(passwordPrompt({ host: "srv.example", username: "carol" }));
    expect(result).toEqual(passwordResponse(`srv.example:password`, "new"));
    expect(innerCalls).toHaveLength(2);
  });
});

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
    expect(innerCalls).toHaveLength(2);
  });
});

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
    expect(innerCalls).toHaveLength(2);

    await handler(passwordPrompt({ host: "h1.example", username: "alice" }));
    expect(innerCalls).toHaveLength(2);

    await handler(passwordPrompt({ host: "h1.example", username: "bob" }));
    expect(innerCalls).toHaveLength(2);
  });

  it("keeps a key's passphrase apart from the password", async () => {
    const inner = mock(
      async (prompt: SshAuthPrompt): Promise<SshAuthResponse> =>
        passwordResponse(prompt.promptId, prompt.kind === "password" ? prompt.field : ""),
    );
    const handler = createCachingAuthPromptHandler(inner);
    const passphrase: SshAuthPrompt = {
      ...passwordPrompt({ host: "h1.example" }),
      prompt: "Enter passphrase for key '/home/alice/.ssh/id_ed25519':",
      field: "passphrase",
    };

    await handler(passphrase);
    const password = await handler(passwordPrompt({ host: "h1.example" }));
    const again = await handler(passphrase);

    expect(password).toMatchObject({ value: "password" });
    expect(again).toMatchObject({ value: "passphrase" });
    expect(inner).toHaveBeenCalledTimes(2);
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
    expect(innerCalls).toHaveLength(2);
  });
});
