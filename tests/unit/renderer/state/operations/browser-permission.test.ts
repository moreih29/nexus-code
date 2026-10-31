/**
 * Unit tests for the browser permission subscription module: main's
 * `browserPermission` broadcasts reach the prompt queue, and a second install
 * replaces the first instead of doubling it.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PermissionPromptPayload } from "../../../../../src/renderer/components/ui/permission-prompt-dialog";

const shown: PermissionPromptPayload[] = [];
const dismissed: string[] = [];

mock.module("../../../../../src/renderer/components/ui/permission-prompt-dialog", () => ({
  showPermissionPrompt: (payload: PermissionPromptPayload) => shown.push(payload),
  dismissPermissionPrompt: (promptId: string) => dismissed.push(promptId),
}));

const { initBrowserPermissionSubscriptions } = await import(
  "../../../../../src/renderer/state/operations/browser-permission"
);

/** Live listeners by "channel.event"; an unsubscribe removes its entry. */
let listeners: Map<string, Set<(payload: unknown) => void>>;

function emit(key: string, payload: unknown): void {
  for (const listener of listeners.get(key) ?? []) listener(payload);
}

const PROMPT: PermissionPromptPayload = {
  promptId: "prompt-1",
  workspaceId: "ws-1",
  origin: "https://example.com",
  permissions: ["geolocation"],
};

beforeEach(() => {
  shown.length = 0;
  dismissed.length = 0;
  listeners = new Map();
  (globalThis as Record<string, unknown>).window = {
    ipc: {
      call: () => Promise.resolve(null),
      listen: (channel: string, event: string, listener: (payload: unknown) => void) => {
        const key = `${channel}.${event}`;
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => set.delete(listener);
      },
      off: () => {},
    },
  };
});

describe("initBrowserPermissionSubscriptions", () => {
  it("queues a prompt on browserPermission.prompt and drops it on .dismissed", () => {
    initBrowserPermissionSubscriptions();

    emit("browserPermission.prompt", PROMPT);
    emit("browserPermission.dismissed", { promptId: "prompt-1" });

    expect(shown).toEqual([PROMPT]);
    expect(dismissed).toEqual(["prompt-1"]);
  });

  it("a second install removes the first one's listeners", () => {
    initBrowserPermissionSubscriptions();
    initBrowserPermissionSubscriptions();

    emit("browserPermission.prompt", PROMPT);

    expect(shown).toEqual([PROMPT]);
  });
});
