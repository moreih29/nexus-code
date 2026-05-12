/**
 * Scenario tests for the singleton SSH auth prompt dialog and FIFO controller.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SshAuthPromptDialogContent,
  copySshHostKeyFingerprint,
  sshAuthPromptInputType,
} from "../../../../src/renderer/components/workspace/SshAuthPromptDialog";
import {
  __resetSshAuthPromptsForTests,
  type SshAuthPromptState,
  getSshAuthPromptSnapshot,
  installSshAuthPromptListeners,
  sshAuthPendingMessage,
  useSshAuthPrompts,
} from "../../../../src/renderer/components/workspace/useSshAuthPrompts";
import type { ipcCall, ipcListen } from "../../../../src/renderer/ipc/client";
import type { SshAuthPrompt } from "../../../../src/shared/types/ssh-auth-prompt";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("SshAuthPromptDialogContent", () => {
  it("renders a masked password prompt with accessible dialog labels", () => {
    const prompt = makePasswordPrompt({ promptId: "password-1" });

    const html = renderToStaticMarkup(
      <SshAuthPromptDialogContent
        prompt={prompt}
        passwordValue=""
        pendingMessage={null}
        onPasswordChange={() => {}}
        onCancel={() => {}}
        onCopyFingerprint={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(sshAuthPromptInputType("password")).toBe("password");
    expect(html).toContain("SSH password required");
    expect(html).toContain('type="password"');
    expect(html).toContain("alice@example.com:22");
    expect(html).toContain('id="ssh-auth-title-password-1"');
    expect(html).toContain('id="ssh-auth-description-password-1"');
  });

  it("renders a host-key trust prompt with monospace fingerprint and copy action", () => {
    const prompt = makeHostKeyPrompt({ promptId: "host-key-1" });

    const html = renderToStaticMarkup(
      <SshAuthPromptDialogContent
        prompt={prompt}
        passwordValue=""
        pendingMessage="1 / 2 pending"
        onPasswordChange={() => {}}
        onCancel={() => {}}
        onCopyFingerprint={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Trust SSH host key");
    expect(html).toContain("1 / 2 pending");
    expect(html).toContain("SHA256:abcdef1234567890");
    expect(html).toContain("font-mono text-[14px]");
    expect(html).toContain(">Copy<");
    expect(html).toContain(">Cancel<");
    expect(html).toContain(">Trust<");
  });

  it("copies the host-key fingerprint through the renderer clipboard helper", () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: (value: string) => copied.push(value) } },
    });

    copySshHostKeyFingerprint("SHA256:copied");

    expect(copied).toEqual(["SHA256:copied"]);
  });
});

describe("Ssh auth prompt FIFO controller", () => {
  it("registers the singleton sshAuth prompt listener", () => {
    __resetSshAuthPromptsForTests();
    const callbacks = new Map<string, (prompt: SshAuthPrompt) => void>();
    const unlistened: string[] = [];
    const listen = ((channel: string, event: string, callback: (prompt: unknown) => void) => {
      const key = `${channel}.${event}`;
      callbacks.set(key, callback as (prompt: SshAuthPrompt) => void);
      return () => unlistened.push(key);
    }) as typeof ipcListen;

    const unlisten = installSshAuthPromptListeners(listen);
    expect(Array.from(callbacks.keys())).toEqual(["sshAuth.prompt"]);

    callbacks.get("sshAuth.prompt")?.(makePasswordPrompt({ promptId: "global-password" }));
    expect(getSshAuthPromptSnapshot().currentPrompt?.promptId).toBe("global-password");

    unlisten();
    expect(unlistened).toEqual(["sshAuth.prompt"]);
  });

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
    emitPrompt(callbacks, makePasswordPrompt({ promptId: "retry", prompt: "Password failed. Try again:" }));

    expect(getSshAuthPromptSnapshot().pendingPrompts).toHaveLength(1);
    expect(
      ExtractPasswordPrompt(getSshAuthPromptSnapshot().currentPrompt)?.prompt,
    ).toBe("Password failed. Try again:");
  });
});

describe("Global SSH auth prompt mount", () => {
  it("keeps the SSH auth dialog/listener in global roots", async () => {
    const globalRoots = await Bun.file("src/renderer/components/global-roots.tsx").text();

    expect(globalRoots).toContain("<SshAuthPromptsRoot />");
    expect(globalRoots).toContain("useSshAuthPrompts");
    expect(globalRoots).toContain("<SshAuthPromptDialog");
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

function emitPrompt(callbacks: Map<string, (prompt: SshAuthPrompt) => void>, prompt: SshAuthPrompt): void {
  const callback = callbacks.get("sshAuth.prompt");
  if (!callback) throw new Error("Missing sshAuth.prompt listener");
  callback(prompt);
}

function readSshAuthPromptState(call: typeof ipcCall): SshAuthPromptState {
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
  readonly call: typeof ipcCall;
  readonly calls: IpcCallRecord[];
} {
  const calls: IpcCallRecord[] = [];
  const call = ((channel: string, method: string, args: unknown) => {
    calls.push({ channel, method, args });
    return Promise.resolve(undefined);
  }) as typeof ipcCall;

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
