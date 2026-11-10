/**
 * Scenario tests for the singleton SSH auth prompt FIFO controller.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  __resetSshAuthPromptsForTests,
  getSshAuthPromptSnapshot,
  installSshAuthPromptListeners,
  type SshAuthPromptState,
  sshAuthPendingMessage,
  useSshAuthPrompts,
} from "../../../../src/renderer/components/workspace/use-ssh-auth-prompts";
import type { ipcCallResult, ipcListen } from "../../../../src/renderer/ipc/client";
import type { SshAuthPrompt } from "../../../../src/shared/ssh/auth-prompt";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("Ssh auth prompt FIFO controller", () => {
  it("serializes prompts FIFO and responds to password then host-key prompts", () => {
    __resetSshAuthPromptsForTests();
    const { callbacks } = installPromptListenerHarness();
    emitPrompt(callbacks, makePasswordPrompt({ promptId: "first" }));
    emitPrompt(callbacks, makeHostKeyPrompt({ promptId: "second" }));

    expect(getSshAuthPromptSnapshot().currentPrompt?.promptId).toBe("first");
    expect(sshAuthPendingMessage(getSshAuthPromptSnapshot().pendingPrompts)).toBe("1 / 2 pending");

    const { call, calls } = createIpcCallRecorder();
    readSshAuthPromptState(call).respondPassword("secret");

    expect(calls[0]).toEqual({
      channel: "sshAuth",
      method: "respond",
      args: { kind: "password", promptId: "first", value: "secret" },
    });
    expect(getSshAuthPromptSnapshot().currentPrompt?.promptId).toBe("second");

    readSshAuthPromptState(call).trustHostKey();
    expect(calls[1]).toEqual({
      channel: "sshAuth",
      method: "respond",
      args: { kind: "host-key", promptId: "second", trust: "yes" },
    });
    expect(getSshAuthPromptSnapshot().currentPrompt).toBeNull();
  });

  it("cancels only the current prompt and leaves queued prompts pending", () => {
    __resetSshAuthPromptsForTests();
    const { callbacks } = installPromptListenerHarness();
    emitPrompt(callbacks, makePasswordPrompt({ promptId: "cancel-me" }));
    emitPrompt(callbacks, makePasswordPrompt({ promptId: "keep-me" }));

    const { call, calls } = createIpcCallRecorder();
    readSshAuthPromptState(call).cancelCurrent();

    expect(calls).toEqual([
      { channel: "sshAuth", method: "cancel", args: { promptId: "cancel-me" } },
    ]);
    expect(getSshAuthPromptSnapshot().currentPrompt?.promptId).toBe("keep-me");
  });

  it("replaces duplicate prompt ids in place for retry state", () => {
    __resetSshAuthPromptsForTests();
    const { callbacks } = installPromptListenerHarness();
    emitPrompt(callbacks, makePasswordPrompt({ promptId: "retry", prompt: "Password:" }));
    emitPrompt(
      callbacks,
      makePasswordPrompt({ promptId: "retry", prompt: "Password failed. Try again:" }),
    );

    expect(getSshAuthPromptSnapshot().pendingPrompts).toHaveLength(1);
    expect(ExtractPasswordPrompt(getSshAuthPromptSnapshot().currentPrompt)?.prompt).toBe(
      "Password failed. Try again:",
    );
  });
});

function ExtractPasswordPrompt(
  prompt: SshAuthPrompt | null,
): Extract<SshAuthPrompt, { kind: "password" }> | null {
  return prompt?.kind === "password" ? prompt : null;
}

function installPromptListenerHarness(): {
  callbacks: Map<string, (prompt: SshAuthPrompt) => void>;
} {
  const callbacks = new Map<string, (prompt: SshAuthPrompt) => void>();
  const listen = ((channel: string, event: string, callback: (prompt: unknown) => void) => {
    callbacks.set(`${channel}.${event}`, callback as (prompt: SshAuthPrompt) => void);
    return () => {};
  }) as typeof ipcListen;

  installSshAuthPromptListeners(listen);
  return { callbacks };
}

function emitPrompt(
  callbacks: Map<string, (prompt: SshAuthPrompt) => void>,
  prompt: SshAuthPrompt,
): void {
  const callback = callbacks.get("sshAuth.prompt");
  if (!callback) throw new Error("Missing sshAuth.prompt listener");
  callback(prompt);
}

function readSshAuthPromptState(call: typeof ipcCallResult): SshAuthPromptState {
  let state: SshAuthPromptState | null = null;
  const listen = (() => () => {}) as typeof ipcListen;

  function CaptureSshAuthPromptState(): null {
    state = useSshAuthPrompts({ call, listen });
    return null;
  }

  renderToStaticMarkup(<CaptureSshAuthPromptState />);
  if (!state) throw new Error("Failed to capture SSH auth prompt state");
  return state;
}

interface IpcCallRecord {
  readonly channel: string;
  readonly method: string;
  readonly args: unknown;
}

function createIpcCallRecorder(): {
  readonly call: typeof ipcCallResult;
  readonly calls: IpcCallRecord[];
} {
  const calls: IpcCallRecord[] = [];
  const call = ((channel: string, method: string, args: unknown) => {
    calls.push({ channel, method, args });
    return Promise.resolve({ ok: true as const, value: undefined });
  }) as typeof ipcCallResult;

  return { call, calls };
}

function makePasswordPrompt(overrides: Partial<SshAuthPrompt> = {}): SshAuthPrompt {
  return {
    kind: "password",
    promptId: "password-id",
    workspaceId: WORKSPACE_ID,
    host: "example.com",
    port: 22,
    username: "alice",
    prompt: "Password for alice@example.com:",
    field: "password",
    ...overrides,
  };
}

function makeHostKeyPrompt(overrides: Partial<SshAuthPrompt> = {}): SshAuthPrompt {
  return {
    kind: "host-key",
    promptId: "host-key-id",
    workspaceId: WORKSPACE_ID,
    host: "example.com",
    port: 22,
    username: "alice",
    keyType: "ed25519",
    fingerprint: "SHA256:abcdef1234567890",
    message: "The authenticity of host 'example.com' cannot be established.",
    ...overrides,
  };
}
