/**
 * Git helper dialog tests cover renderer-only seams without bypassing the
 * production IPC contract in store code.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommitMessageDialogContent,
  hasCommitMessageBody,
} from "../../../../../../src/renderer/components/files/git/commit/message-dialog";
import {
  CredentialPromptDialogContent,
  credentialPromptInputType,
} from "../../../../../../src/renderer/components/files/git/dialogs/credential-prompt-dialog";
import {
  __resetGitHelperPromptsForTests,
  type GitHelperPromptState,
  getGitHelperPromptSnapshot,
  gitHelperOccupancyMessage,
  gitHelperOccupancyMessageForWorkspace,
  installGitHelperPromptListeners,
  isPromptForWorkspace,
  useGitHelperPrompts,
} from "../../../../../../src/renderer/components/files/git/hooks/use-git-helper-prompts";
import type { ipcCall, ipcListen } from "../../../../../../src/renderer/ipc/client";
import type { AskpassPrompt, GitEditorPrompt } from "../../../../../../src/shared/git/types";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_WORKSPACE_ID = "223e4567-e89b-12d3-a456-426614174000";

describe("CredentialPromptDialogContent", () => {
  it("masks password and passphrase prompts", () => {
    expect(credentialPromptInputType("username")).toBe("text");
    expect(credentialPromptInputType("password")).toBe("password");
    expect(credentialPromptInputType("passphrase")).toBe("password");
  });

  it("renders the active askpass prompt in a reusable dialog body", () => {
    const prompt = makeAskpassPrompt({
      promptId: "prompt-1",
      prompt: "Password for 'https://example.com':",
      field: "password",
    });

    const html = renderToStaticMarkup(
      <CredentialPromptDialogContent
        prompt={prompt}
        value=""
        onValueChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Git credentials");
    expect(html).toContain('type="password"');
    expect(html).toContain("Password for");
  });
});

describe("CommitMessageDialogContent", () => {
  it("renders a monospace commit message editor and validates comment-only text", () => {
    const prompt = makeEditorPrompt();
    const html = renderToStaticMarkup(
      <CommitMessageDialogContent
        prompt={prompt}
        content={"subject\n\n# comment\n"}
        onContentChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Commit message");
    expect(html).toContain("font-mono");
    expect(hasCommitMessageBody("# comment only\n")).toBe(false);
    expect(hasCommitMessageBody("subject\n# comment\n")).toBe(true);
  });
});

describe("Git helper prompt workspace filtering and banner copy", () => {
  it("accepts matching or process-wide prompts only", () => {
    expect(isPromptForWorkspace({ workspaceId: WORKSPACE_ID }, WORKSPACE_ID)).toBe(true);
    expect(isPromptForWorkspace({}, WORKSPACE_ID)).toBe(true);
    expect(isPromptForWorkspace({ workspaceId: "other" }, WORKSPACE_ID)).toBe(false);
  });

  it("shows queue occupancy only while a prompt is active", () => {
    const credentialPrompt = makeAskpassPrompt({ promptId: "p1" });
    const editorPrompt = makeEditorPrompt();

    expect(gitHelperOccupancyMessage({ credentialPrompt, editorPrompt: null })).toBe(
      "Awaiting credentials…",
    );
    expect(gitHelperOccupancyMessage({ credentialPrompt: null, editorPrompt })).toBe(
      "Editing commit message…",
    );
    expect(gitHelperOccupancyMessage({ credentialPrompt: null, editorPrompt: null })).toBeNull();
  });

  it("derives GitPanel occupancy from global prompts without accepting other workspaces", () => {
    const credentialPrompt = makeAskpassPrompt({ promptId: "p1" });
    const otherPrompt = makeAskpassPrompt({ promptId: "p2", workspaceId: "other" });
    const globalEditorPrompt = makeEditorPrompt({ workspaceId: undefined });

    expect(
      gitHelperOccupancyMessageForWorkspace({
        workspaceId: WORKSPACE_ID,
        credentialPrompt,
        editorPrompt: null,
      }),
    ).toBe("Awaiting credentials…");
    expect(
      gitHelperOccupancyMessageForWorkspace({
        workspaceId: WORKSPACE_ID,
        credentialPrompt: otherPrompt,
        editorPrompt: null,
      }),
    ).toBeNull();
    expect(
      gitHelperOccupancyMessageForWorkspace({
        workspaceId: WORKSPACE_ID,
        credentialPrompt: null,
        editorPrompt: globalEditorPrompt,
      }),
    ).toBe("Editing commit message…");
  });
});

describe("Global Git helper prompt mounting contract", () => {
  it("registers the singleton askpass and editor prompt listeners", () => {
    __resetGitHelperPromptsForTests();
    const callbacks = new Map<string, (prompt: AskpassPrompt | GitEditorPrompt) => void>();
    const unlistened: string[] = [];
    const listen = ((channel: string, event: string, callback: (prompt: unknown) => void) => {
      const key = `${channel}.${event}`;
      callbacks.set(key, callback as (prompt: AskpassPrompt | GitEditorPrompt) => void);
      return () => unlistened.push(key);
    }) as typeof ipcListen;

    const unlisten = installGitHelperPromptListeners(listen);
    expect(Array.from(callbacks.keys()).sort()).toEqual(["askpass.prompt", "editor.prompt"]);

    const credentialPrompt = makeAskpassPrompt({ promptId: "global-credential" });
    callbacks.get("askpass.prompt")?.(credentialPrompt);
    expect(getGitHelperPromptSnapshot().credentialPrompt?.promptId).toBe("global-credential");

    const editorPrompt = makeEditorPrompt({ promptId: "global-editor" });
    callbacks.get("editor.prompt")?.(editorPrompt);
    expect(getGitHelperPromptSnapshot().credentialPrompt?.promptId).toBe("global-credential");
    expect(getGitHelperPromptSnapshot().editorPrompt).toBeNull();
    expect(
      getGitHelperPromptSnapshot().pendingEditorPrompts.map((prompt) => prompt.promptId),
    ).toEqual(["global-editor"]);

    unlisten();
    expect(unlistened.sort()).toEqual(["askpass.prompt", "editor.prompt"]);
  });

  it("keeps dialogs/listeners globally mounted rather than GitPanel-owned", async () => {
    const globalRoots = await Bun.file("src/renderer/components/global-roots/index.tsx").text();
    const gitPanel = await Bun.file("src/renderer/components/files/git/panel/git-panel.tsx").text();

    expect(globalRoots).toContain("<GitHelperPromptsRoot />");
    expect(globalRoots).toContain("useGitHelperPrompts");
    expect(gitPanel).toContain("useGitHelperOccupancy");
    expect(gitPanel).not.toContain("useGitHelperPrompts(");
    expect(gitPanel).not.toContain("<CredentialPromptDialog");
    expect(gitPanel).not.toContain("<CommitMessageDialog");
  });
});

describe("Git helper prompt queue serialization", () => {
  it("serializes concurrent askpass prompts and advances after response and cancel", () => {
    __resetGitHelperPromptsForTests();
    const { callbacks, unlisten } = installPromptListenerHarness();
    const firstPrompt = makeAskpassPrompt({ promptId: "askpass-1" });
    const secondPrompt = makeAskpassPrompt({ promptId: "askpass-2", field: "password" });

    emitPrompt(callbacks, "askpass.prompt", firstPrompt);
    emitPrompt(callbacks, "askpass.prompt", secondPrompt);

    expect(getGitHelperPromptSnapshot().credentialPrompt?.promptId).toBe("askpass-1");
    expect(
      getGitHelperPromptSnapshot().pendingCredentialPrompts.map((prompt) => prompt.promptId),
    ).toEqual(["askpass-1", "askpass-2"]);

    const { call, calls } = createIpcCallRecorder();
    readHelperPromptState(call).respondCredential("alice");

    expect(calls).toEqual([
      {
        channel: "askpass",
        method: "respond",
        args: { promptId: "askpass-1", value: "alice" },
      },
    ]);
    expect(getGitHelperPromptSnapshot().credentialPrompt?.promptId).toBe("askpass-2");
    expect(
      getGitHelperPromptSnapshot().pendingCredentialPrompts.map((prompt) => prompt.promptId),
    ).toEqual(["askpass-2"]);

    readHelperPromptState(call).cancelCredential();

    expect(calls[1]).toEqual({
      channel: "askpass",
      method: "cancel",
      args: { promptId: "askpass-2" },
    });
    expect(getGitHelperPromptSnapshot().credentialPrompt).toBeNull();
    expect(getGitHelperPromptSnapshot().pendingCredentialPrompts).toEqual([]);

    unlisten();
  });

  it("keeps askpass plus editor overlap FIFO while preserving per-workspace banners", () => {
    __resetGitHelperPromptsForTests();
    const { callbacks, unlisten } = installPromptListenerHarness();
    const credentialPrompt = makeAskpassPrompt({ promptId: "askpass-active" });
    const editorPrompt = makeEditorPrompt({
      promptId: "editor-queued",
      workspaceId: OTHER_WORKSPACE_ID,
    });

    emitPrompt(callbacks, "askpass.prompt", credentialPrompt);
    emitPrompt(callbacks, "editor.prompt", editorPrompt);

    expect(getGitHelperPromptSnapshot().credentialPrompt?.promptId).toBe("askpass-active");
    expect(getGitHelperPromptSnapshot().editorPrompt).toBeNull();
    expect(
      getGitHelperPromptSnapshot().pendingEditorPrompts.map((prompt) => prompt.promptId),
    ).toEqual(["editor-queued"]);
    expect(
      gitHelperOccupancyMessageForWorkspace({
        workspaceId: WORKSPACE_ID,
        pendingCredentialPrompts: getGitHelperPromptSnapshot().pendingCredentialPrompts,
        pendingEditorPrompts: getGitHelperPromptSnapshot().pendingEditorPrompts,
        credentialPrompt: getGitHelperPromptSnapshot().credentialPrompt,
        editorPrompt: getGitHelperPromptSnapshot().editorPrompt,
      }),
    ).toBe("Awaiting credentials…");
    expect(
      gitHelperOccupancyMessageForWorkspace({
        workspaceId: OTHER_WORKSPACE_ID,
        pendingCredentialPrompts: getGitHelperPromptSnapshot().pendingCredentialPrompts,
        pendingEditorPrompts: getGitHelperPromptSnapshot().pendingEditorPrompts,
        credentialPrompt: getGitHelperPromptSnapshot().credentialPrompt,
        editorPrompt: getGitHelperPromptSnapshot().editorPrompt,
      }),
    ).toBe("Editing commit message…");

    const { call, calls } = createIpcCallRecorder();
    readHelperPromptState(call).cancelCredential();

    expect(calls[0]).toEqual({
      channel: "askpass",
      method: "cancel",
      args: { promptId: "askpass-active" },
    });
    expect(getGitHelperPromptSnapshot().credentialPrompt).toBeNull();
    expect(getGitHelperPromptSnapshot().editorPrompt?.promptId).toBe("editor-queued");

    readHelperPromptState(call).saveCommitMessage("queued editor body\n");

    expect(calls[1]).toEqual({
      channel: "editor",
      method: "save",
      args: { promptId: "editor-queued", content: "queued editor body\n" },
    });
    expect(getGitHelperPromptSnapshot().editorPrompt).toBeNull();
    expect(getGitHelperPromptSnapshot().pendingEditorPrompts).toEqual([]);

    unlisten();
  });
});

/**
 * Creates a valid askpass prompt fixture with optional overrides.
 */
function makeAskpassPrompt(overrides: Partial<AskpassPrompt> = {}): AskpassPrompt {
  return {
    promptId: "prompt-id",
    workspaceId: WORKSPACE_ID,
    prompt: "Username for 'https://example.com':",
    field: "username",
    service: "https://example.com",
    ...overrides,
  };
}

/**
 * Installs the production listener adapter against in-memory callbacks.
 */
function installPromptListenerHarness(): {
  callbacks: Map<string, (prompt: AskpassPrompt | GitEditorPrompt) => void>;
  unlisten: () => void;
} {
  const callbacks = new Map<string, (prompt: AskpassPrompt | GitEditorPrompt) => void>();
  const listen = ((channel: string, event: string, callback: (prompt: unknown) => void) => {
    callbacks.set(
      `${channel}.${event}`,
      callback as (prompt: AskpassPrompt | GitEditorPrompt) => void,
    );
    return () => {};
  }) as typeof ipcListen;

  return {
    callbacks,
    unlisten: installGitHelperPromptListeners(listen),
  };
}

/**
 * Emits a prompt into a listener harness and fails loudly if the listener was
 * not installed.
 */
function emitPrompt(
  callbacks: Map<string, (prompt: AskpassPrompt | GitEditorPrompt) => void>,
  key: string,
  prompt: AskpassPrompt | GitEditorPrompt,
): void {
  const callback = callbacks.get(key);
  if (!callback) throw new Error(`Missing listener for ${key}`);
  callback(prompt);
}

/**
 * Captures the hook's response callbacks with a supplied IPC call seam.
 */
function readHelperPromptState(call: typeof ipcCall): GitHelperPromptState {
  let state: GitHelperPromptState | null = null;
  const listen = (() => () => {}) as typeof ipcListen;

  function CaptureHelperPromptState(): null {
    state = useGitHelperPrompts({ call, listen });
    return null;
  }

  renderToStaticMarkup(<CaptureHelperPromptState />);
  if (!state) throw new Error("Failed to capture Git helper prompt state");
  return state;
}

interface IpcCallRecord {
  readonly channel: string;
  readonly method: string;
  readonly args: unknown;
}

/**
 * Records response/cancel calls without reaching the Electron preload bridge.
 */
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

/**
 * Creates a valid editor prompt fixture.
 */
function makeEditorPrompt(overrides: Partial<GitEditorPrompt> = {}): GitEditorPrompt {
  return {
    promptId: "editor-id",
    workspaceId: WORKSPACE_ID,
    kind: "commit-message",
    filePath: "/tmp/COMMIT_EDITMSG",
    initialContent: "subject\n",
    ...overrides,
  };
}
