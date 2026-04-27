import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isTerminalIpcCommand,
  isTerminalIpcEvent,
  isTerminalIpcMessage,
} from "./terminal-ipc";
import type { TerminalIpcCommand, TerminalIpcEvent, TerminalIpcMessage } from "./terminal-ipc";
import type { TerminalLifecycleMessage } from "./terminal-lifecycle";
import type { TerminalTabId } from "./terminal-tab";

function assertNever(value: never): never {
  throw new Error(`Unhandled message variant: ${JSON.stringify(value)}`);
}

function visitCommand(command: TerminalIpcCommand): TerminalIpcCommand["type"] {
  switch (command.type) {
    case "terminal/open":
    case "terminal/input":
    case "terminal/resize":
    case "terminal/close":
    case "terminal/scrollback-stats/query":
      return command.type;
    default:
      return assertNever(command);
  }
}

function visitEvent(event: TerminalIpcEvent): TerminalIpcEvent["type"] {
  switch (event.type) {
    case "terminal/opened":
    case "terminal/stdout":
    case "terminal/exited":
    case "terminal/scrollback-stats/reply":
      return event.type;
    default:
      return assertNever(event);
  }
}

function visitMessage(message: TerminalIpcMessage): TerminalIpcMessage["type"] {
  switch (message.type) {
    case "terminal/open":
    case "terminal/input":
    case "terminal/resize":
    case "terminal/close":
    case "terminal/scrollback-stats/query":
    case "terminal/opened":
    case "terminal/stdout":
    case "terminal/exited":
    case "terminal/scrollback-stats/reply":
      return message.type;
    default:
      return assertNever(message);
  }
}

function visitLifecycleMessage(
  message: TerminalLifecycleMessage,
): TerminalLifecycleMessage["type"] {
  switch (message.type) {
    case "terminal/workspace-terminals-closed":
      return message.type;
    default:
      return assertNever(message);
  }
}

type HasTypeDiscriminator<T> = T extends { type: string } ? true : false;

const ipcMessageHasType: HasTypeDiscriminator<TerminalIpcMessage> = true;
const lifecycleMessageHasType: HasTypeDiscriminator<TerminalLifecycleMessage> = true;

const CONTRACT_FILES = ["terminal-tab.ts", "terminal-ipc.ts", "terminal-lifecycle.ts"] as const;
const CONTRACT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

describe("terminal shared contracts", () => {
  test("discriminated unions stay exhaustive on type", () => {
    expect(ipcMessageHasType).toBe(true);
    expect(lifecycleMessageHasType).toBe(true);

    const tabId = "tt_ws_alpha_001" as TerminalTabId;

    const commandTypes = [
      visitCommand({
        type: "terminal/open",
        workspaceId: "ws_alpha",
        cols: 120,
        rows: 32,
      }),
      visitCommand({
        type: "terminal/input",
        tabId,
        data: "ls\n",
      }),
      visitCommand({
        type: "terminal/resize",
        tabId,
        cols: 80,
        rows: 24,
      }),
      visitCommand({
        type: "terminal/close",
        tabId,
        reason: "user-close",
      }),
      visitCommand({
        type: "terminal/scrollback-stats/query",
        tabId,
      }),
    ];

    expect(commandTypes).toEqual([
      "terminal/open",
      "terminal/input",
      "terminal/resize",
      "terminal/close",
      "terminal/scrollback-stats/query",
    ]);

    const eventTypes = [
      visitEvent({
        type: "terminal/opened",
        tabId,
        workspaceId: "ws_alpha",
        pid: 4242,
      }),
      visitEvent({
        type: "terminal/stdout",
        tabId,
        seq: 1,
        data: "ready\n",
      }),
      visitEvent({
        type: "terminal/exited",
        tabId,
        workspaceId: "ws_alpha",
        reason: "process-exit",
        exitCode: 0,
      }),
      visitEvent({
        type: "terminal/scrollback-stats/reply",
        tabId,
        mainBufferByteLimit: 8_388_608,
        mainBufferStoredBytes: 128,
        mainBufferDroppedBytesTotal: 0,
        xtermScrollbackLines: 10_000,
      }),
    ];

    expect(eventTypes).toEqual([
      "terminal/opened",
      "terminal/stdout",
      "terminal/exited",
      "terminal/scrollback-stats/reply",
    ]);

    expect(
      visitMessage({
        type: "terminal/open",
        workspaceId: "ws_alpha",
        cols: 100,
        rows: 20,
      }),
    ).toBe("terminal/open");

    expect(
      visitLifecycleMessage({
        type: "terminal/workspace-terminals-closed",
        workspaceId: "ws_alpha",
        closedTabIds: [tabId],
        reason: "workspace-close",
      }),
    ).toBe("terminal/workspace-terminals-closed");
  });

  test("runtime terminal IPC guards accept valid union members and reject malformed payloads", () => {
    const tabId = "tt_ws_alpha_guard_001" as TerminalTabId;
    const openCommand: TerminalIpcMessage = {
      type: "terminal/open",
      workspaceId: "ws_alpha",
      cols: 120,
      rows: 32,
    };
    const stdoutEvent: TerminalIpcMessage = {
      type: "terminal/stdout",
      tabId,
      seq: 0,
      data: "ready\n",
    };

    expect(isTerminalIpcMessage(openCommand)).toBe(true);
    expect(isTerminalIpcCommand(openCommand)).toBe(true);
    expect(isTerminalIpcEvent(openCommand)).toBe(false);

    expect(isTerminalIpcMessage(stdoutEvent)).toBe(true);
    expect(isTerminalIpcCommand(stdoutEvent)).toBe(false);
    expect(isTerminalIpcEvent(stdoutEvent)).toBe(true);

    expect(
      isTerminalIpcMessage({
        type: "terminal/stdout",
        tabId,
        seq: -1,
        data: "bad\n",
      }),
    ).toBe(false);
    expect(
      isTerminalIpcMessage({
        type: "terminal/open",
        workspaceId: "",
        cols: 120,
        rows: 32,
      }),
    ).toBe(false);
    expect(
      isTerminalIpcMessage({
        type: "terminal/unknown",
      }),
    ).toBe(false);
    expect(
      isTerminalIpcMessage({
        type: "terminal/input",
        tabId,
        data: "ls\n",
        extra: "forbidden",
      }),
    ).toBe(false);
  });

  test("terminal contracts remain shell-only without harness symbols or kind discriminator", async () => {
    for (const filename of CONTRACT_FILES) {
      const contents = await readFile(path.join(CONTRACT_DIRECTORY, filename), "utf8");

      expect(contents).not.toMatch(/\bharness\b/i);
      expect(contents).not.toMatch(/\bkind\b/);
    }
  });
});
