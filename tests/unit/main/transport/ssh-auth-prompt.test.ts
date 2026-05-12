import { describe, expect, it } from "bun:test";
import {
  AuthCancelledError,
  SshAuthPromptHub,
} from "../../../../src/main/transport/ssh-auth-prompt";
import { ipcContract } from "../../../../src/shared/ipc-contract";
import type { SshAuthPrompt } from "../../../../src/shared/types/ssh-auth-prompt";

interface BroadcastEvent {
  readonly channelName: string;
  readonly event: string;
  readonly args: unknown;
}

describe("sshAuth IPC contract", () => {
  it("registers schemas for respond, cancel, and prompt payloads", () => {
    expect(
      ipcContract.sshAuth.call.respond.args.parse({
        kind: "password",
        promptId: "prompt-1",
        value: "secret",
      }),
    ).toEqual({ kind: "password", promptId: "prompt-1", value: "secret" });
    expect(ipcContract.sshAuth.call.cancel.args.parse({ promptId: "prompt-1" })).toEqual({
      promptId: "prompt-1",
    });
    expect(ipcContract.sshAuth.listen.prompt.args.parse(passwordPrompt("prompt-1"))).toEqual(
      passwordPrompt("prompt-1"),
    );
  });
});

describe("SshAuthPromptHub", () => {
  it("broadcasts a validated prompt payload before waiting for a response", async () => {
    const events: BroadcastEvent[] = [];
    const hub = new SshAuthPromptHub((channelName, event, args) => {
      events.push({ channelName, event, args });
    });

    const promise = hub.request(passwordPrompt("prompt-1"));
    expect(events).toEqual([
      { channelName: "sshAuth", event: "prompt", args: passwordPrompt("prompt-1") },
    ]);

    hub.respond({ kind: "password", promptId: "prompt-1", value: "secret" });
    await expect(promise).resolves.toEqual({
      kind: "password",
      promptId: "prompt-1",
      value: "secret",
    });
  });

  it("rejects invalid prompt payloads without broadcasting", () => {
    const events: BroadcastEvent[] = [];
    const hub = new SshAuthPromptHub((channelName, event, args) => {
      events.push({ channelName, event, args });
    });

    expect(() =>
      hub.request({ kind: "host-key", promptId: "prompt-1", host: "example.com" } as SshAuthPrompt),
    ).toThrow();
    expect(events).toEqual([]);
  });

  it("resolves only the matching pending request by promptId", async () => {
    const hub = new SshAuthPromptHub(() => {});
    const first = hub.request(passwordPrompt("prompt-1"));
    const second = hub.request(hostKeyPrompt("prompt-2"));

    hub.respond({ kind: "host-key", promptId: "prompt-2", trust: "yes" });
    await expect(second).resolves.toEqual({ kind: "host-key", promptId: "prompt-2", trust: "yes" });

    hub.respond({ kind: "password", promptId: "prompt-1", value: "secret" });
    await expect(first).resolves.toEqual({
      kind: "password",
      promptId: "prompt-1",
      value: "secret",
    });
  });

  it("rejects a matching cancel with AuthCancelledError", async () => {
    const hub = new SshAuthPromptHub(() => {});
    const promise = hub.request(passwordPrompt("prompt-1"));

    hub.cancel({ promptId: "prompt-1" });

    await expect(promise).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("treats duplicate respond and cancel calls as no-ops", async () => {
    const hub = new SshAuthPromptHub(() => {});
    const promise = hub.request(passwordPrompt("prompt-1"));

    hub.respond({ kind: "password", promptId: "prompt-1", value: "secret" });
    hub.respond({ kind: "password", promptId: "prompt-1", value: "ignored" });
    hub.cancel({ promptId: "prompt-1" });

    await expect(promise).resolves.toEqual({
      kind: "password",
      promptId: "prompt-1",
      value: "secret",
    });
  });

  it("resolves two simultaneous password promptIds independently", async () => {
    const hub = new SshAuthPromptHub(() => {});
    const first = hub.request(passwordPrompt("prompt-1"));
    const second = hub.request(passwordPrompt("prompt-2"));

    hub.respond({ kind: "password", promptId: "prompt-2", value: "second" });
    hub.respond({ kind: "password", promptId: "prompt-1", value: "first" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "password", promptId: "prompt-1", value: "first" },
      { kind: "password", promptId: "prompt-2", value: "second" },
    ]);
  });
});

function passwordPrompt(promptId: string): SshAuthPrompt {
  return {
    kind: "password",
    promptId,
    host: "example.com",
    port: 22,
    username: "alice",
    prompt: "alice@example.com's password:",
    field: "password",
  };
}

function hostKeyPrompt(promptId: string): SshAuthPrompt {
  return {
    kind: "host-key",
    promptId,
    host: "example.com",
    port: 22,
    keyType: "ED25519",
    fingerprint: "SHA256:abc123",
    message: "The authenticity of host 'example.com' can't be established.",
  };
}
