/** A terminal's controls as another device uses them, and the answer to its Claude Code's request. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import {
  answerTerminal,
  closeTerminal,
  inputTerminal,
  openTerminal,
  renameTerminal,
  terminalShells,
} from "../../../../../src/main/features/remote/terminal-control";

function services(over: Partial<Record<string, unknown>> = {}) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const answers: { askId: string; answer: string }[] = [];
  const s = {
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    managerWorkspace: () => null,
    claudeAsks: (_w: string, tab: string) =>
      tab === "t2" ? [{ id: "h1", tool: "Bash", target: "rm -rf dist", always: [], since: 5 }] : [],
    answerClaudeAsk: async (_w: string, _t: string, askId: string, answer: string) => {
      answers.push({ askId, answer });
      return answer !== "allowAlways";
    },
    ui: async (op: string, args: Record<string, unknown>) => {
      calls.push({ op, args });
      if (op === "tabs.list") {
        return {
          tabs: [
            { id: "t1", type: "claude", title: "Fix" },
            { id: "t2", type: "terminal", title: "zsh" },
          ],
        };
      }
      if (op === "terminal.shells") {
        return {
          shells: [
            { id: "zsh", name: "zsh", path: "/bin/zsh", isDefault: true },
            { id: "bash", name: "bash", path: "/bin/bash", isDefault: false },
          ],
        };
      }
      if (op === "terminal.open") return { tabId: "t9" };
      if (op === "tab.rename") return { title: args.title };
      return {};
    },
    ...over,
  } as unknown as CliServices;
  return { s, calls, answers, typed: () => calls.filter((c) => c.op === "terminal.input") };
}

const ref = { workspaceId: "w1", tabId: "t2" };

describe("typing into a terminal", () => {
  test("text pasted, then Enter, and when it was typed", async () => {
    const { s, typed } = services();
    expect(await inputTerminal(s, { ...ref, text: "ls", enter: true }, () => 42)).toEqual({
      at: 42,
    });
    expect(typed().map((c) => c.args)).toEqual([
      { ...ref, text: "ls", mode: "paste", enter: true },
    ]);
  });

  test("the text, then the keys as a terminal sends them, Enter after the keys", async () => {
    const { s, typed } = services();
    await inputTerminal(s, { ...ref, text: "y", keys: ["ctrl-c", "up"], enter: true });
    expect(typed().map((c) => c.args)).toEqual([
      { ...ref, text: "y", mode: "paste", enter: false },
      { ...ref, text: "\x03\x1b[A", mode: "keys", enter: true },
    ]);
  });

  test("Enter alone; nothing at all is refused", async () => {
    const { s, typed } = services();
    await inputTerminal(s, { ...ref, enter: true });
    expect(typed()[0]?.args).toMatchObject({ text: "", enter: true });
    await expect(inputTerminal(s, { ...ref, text: "", keys: [] })).rejects.toMatchObject({
      code: -32602,
    });
  });

  test("only into a terminal", async () => {
    const { s } = services();
    await expect(
      inputTerminal(s, { workspaceId: "w1", tabId: "t1", text: "x" }),
    ).rejects.toMatchObject({ code: 1001 });
  });

  test("the app failing to type is Unavailable", async () => {
    const { s } = services();
    const ui = s.ui.bind(s);
    const failing = {
      ...s,
      ui: (async (op: string, args: never) => {
        if (op === "terminal.input") throw new Error("the terminal has ended");
        return ui(op as never, args);
      }) as CliServices["ui"],
    };
    await expect(inputTerminal(failing, { ...ref, text: "x" })).rejects.toMatchObject({
      code: 1003,
      message: "the terminal has ended",
    });
  });
});

describe("a terminal's shells, opening, renaming and closing", () => {
  test("the shells, the default marked, no paths", async () => {
    const { s } = services();
    expect(await terminalShells(s, { workspaceId: "w1" })).toEqual({
      shells: [
        { id: "zsh", name: "zsh", isDefault: true },
        { id: "bash", name: "bash", isDefault: false },
      ],
    });
    await expect(terminalShells(s, { workspaceId: "nope" })).rejects.toMatchObject({ code: 1001 });
  });

  test("opens behind what the window shows, in the workspace's folder by default", async () => {
    const { s, calls } = services();
    expect(await openTerminal(s, { workspaceId: "w1", shell: "bash", command: "top" })).toEqual({
      tabId: "t9",
    });
    expect(calls.find((c) => c.op === "terminal.open")?.args).toEqual({
      workspaceId: "w1",
      cwd: "/src/app",
      command: "top",
      shell: "bash",
      placement: { background: true },
    });
  });

  test("in a folder inside the workspace; not one outside it", async () => {
    const { s, calls } = services();
    const fs = async () =>
      ({
        stat: async () => ({ type: "dir", isSymlink: false, size: 0, mtime: 0 }),
      }) as unknown as FsProvider;
    await openTerminal(s, { workspaceId: "w1", folder: "packages/a", title: "a" }, fs);
    expect(calls.find((c) => c.op === "terminal.open")?.args).toMatchObject({
      cwd: "/src/app/packages/a",
      title: "a",
    });
    await expect(openTerminal(s, { workspaceId: "w1", folder: "/etc" }, fs)).rejects.toMatchObject({
      code: 1002,
    });
  });

  test("renames and closes only a terminal", async () => {
    const { s, calls } = services();
    expect(await renameTerminal(s, { ...ref, title: " build " })).toEqual({ title: "build" });
    await expect(renameTerminal(s, { ...ref, title: "  " })).rejects.toMatchObject({
      code: -32602,
    });
    expect(await closeTerminal(s, { ...ref, force: true })).toEqual({});
    expect(calls.find((c) => c.op === "tab.close")?.args).toEqual({ ...ref, force: true });
    await expect(closeTerminal(s, { workspaceId: "w1", tabId: "t1" })).rejects.toMatchObject({
      code: 1001,
    });
  });
});

describe("answering a terminal's Claude Code", () => {
  test("the request it holds", async () => {
    const { s, answers } = services();
    expect(await answerTerminal(s, { ...ref, requestId: "h1", decision: "deny" })).toEqual({});
    expect(answers).toEqual([{ askId: "h1", answer: "deny" }]);
  });

  test("one answered since is NotFound; one it cannot take refused", async () => {
    const { s } = services();
    await expect(
      answerTerminal(s, { ...ref, requestId: "h0", decision: "allow" }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(
      answerTerminal(s, { ...ref, requestId: "h1", decision: "allowAlways" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
