import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { runCli } from "../../../../../src/main/features/cli/registry";
import type { CliUiOps } from "../../../../../src/shared/cli/ui";
import type { CustomShell } from "../../../../../src/shared/pty/shell";
import { contextFor, type FakeApp, fakeApp } from "../../../main/cli/fake-services";

const writes: unknown[] = [];
const programs: Record<string, string> = {
  "/bin/zsh": "/bin/zsh",
  "/opt/homebrew/bin/nu": "/opt/homebrew/bin/nu",
  nu: "/opt/homebrew/bin/nu",
  "/bin/bash": "/bin/bash",
};

const CLIENT = "../../../../../src/renderer/ipc/client";
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel === "pty" && method === "listShells") {
      return Promise.resolve({
        ok: true,
        value: {
          shells: [
            { id: "/bin/zsh", name: "zsh", path: "/bin/zsh", args: [] },
            {
              id: "/opt/homebrew/bin/fish",
              name: "fish",
              path: "/opt/homebrew/bin/fish",
              args: [],
            },
          ],
          systemDefault: { id: "/bin/zsh", name: "zsh", path: "/bin/zsh", args: [] },
        },
      });
    }
    if (channel === "pty" && method === "findShell") {
      const { program } = args as { program: string };
      return Promise.resolve({ ok: true, value: { path: programs[program] ?? null } });
    }
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { shellHandlers } = await import("../../../../../src/renderer/services/cli/shell-actions");
const { useTerminalStore } = await import("../../../../../src/renderer/state/stores/terminal");

const change = shellHandlers["terminal.shells.change"];

const BASH: CustomShell = { id: "bash-login", name: "Bash", path: "/bin/bash", args: ["-l"] };

function app(): FakeApp {
  const made = fakeApp();
  made.uiAnswers.set("terminal.shells.change", (args: CliUiOps["terminal.shells.change"]["args"]) =>
    change(args),
  );
  return made;
}

const nexus = (made: FakeApp, argv: string[]) => runCli(CLI_COMMANDS, contextFor(made, argv));

function shells() {
  const { customShells, shell } = useTerminalStore.getState();
  return { customShells, shell };
}

beforeEach(() => {
  useTerminalStore.getState().hydrateShells({ customShells: [BASH] });
  writes.length = 0;
});

describe("terminal shells add", () => {
  it("shows the program and its arguments, and adds nothing until the user allows it", async () => {
    const made = app();
    const denied = await nexus(made, [
      "terminal",
      "shells",
      "add",
      "Nushell",
      "--program",
      "nu",
      "--arg",
      "-l",
      "--arg=--login",
    ]);
    expect(denied.stderr).toBe("nexus: the user did not allow it\n");
    expect(made.asked.at(-1)?.change).toEqual({
      kind: "shellAdd",
      detail: "Nushell",
      settingsEdit: {
        lines: [
          { field: "program", to: "nu (/opt/homebrew/bin/nu)" },
          { field: "args", to: "-l --login" },
        ],
      },
      eachTime: true,
    });
    expect(shells().customShells).toEqual([BASH]);
    expect(writes).toEqual([]);

    made.answers.push("once");
    const added = await nexus(made, [
      "terminal",
      "shells",
      "add",
      "Nushell",
      "--program",
      "nu",
      "--arg",
      "-l",
      "--json",
    ]);
    expect(added.exitCode).toBe(0);
    const [, nushell] = shells().customShells;
    expect(nushell).toMatchObject({ name: "Nushell", path: "nu", args: ["-l"] });
    expect(JSON.parse(added.stdout)).toEqual({ shell: nushell, found: "/opt/homebrew/bin/nu" });
    expect(writes).toEqual([{ terminalShells: [BASH, nushell] }]);
  });

  it("refuses a taken or reserved name, a program not found and --device before asking", async () => {
    const made = app();
    const tries = [
      [["zsh", "--program", "/bin/zsh"], 'a shell is already named "zsh"'],
      [["bash", "--program", "/bin/zsh"], 'a shell is already named "Bash"'],
      [["System", "--program", "/bin/zsh"], '"system" names the system\'s default shell'],
      [["Fish", "--program", "/bin/zsh"], 'a shell is already named "fish"'],
      [["Elvish", "--program", "elvish"], 'no program "elvish" was found on this computer'],
      [["Elvish", "--program", " "], "a shell needs a program"],
      [["Elvish"], "give --program PATH"],
      [["Elvish", "--program", "/bin/zsh", "--device", "Mac mini"], "--device is not taken here"],
    ] as const;
    for (const [argv, message] of tries) {
      const result = await nexus(made, ["terminal", "shells", "add", ...argv]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
    expect(made.asked).toEqual([]);
    expect(shells().customShells).toEqual([BASH]);
  });
});

describe("terminal shells edit and remove", () => {
  it("lists each change with its before and after, and saves it once allowed", async () => {
    const made = app();
    made.answers.push("once");
    const edited = await nexus(made, [
      "terminal",
      "shells",
      "edit",
      "bash",
      "--name",
      "Login Bash",
      "--clear-args",
    ]);
    expect(edited.stdout).toBe('Changed the shell "Login Bash": /bin/bash.\n');
    expect(made.asked.at(-1)?.change).toMatchObject({
      kind: "shellEdit",
      detail: "Bash",
      settingsEdit: {
        lines: [
          { field: "name", from: "Bash", to: "Login Bash" },
          { field: "program", to: "/bin/bash" },
          { field: "args", from: "-l", to: "" },
        ],
      },
    });
    expect(shells().customShells).toEqual([{ ...BASH, name: "Login Bash", args: [] }]);
  });

  it("refuses a shell found on the computer, an unknown one and a change of nothing", async () => {
    const made = app();
    const tries = [
      [["edit", "zsh", "--name", "Z"], '"zsh" was found on this computer'],
      [["remove", "zsh"], '"zsh" was found on this computer'],
      [["remove", "elvish"], 'no shell is named "elvish"'],
      [["edit", "Bash", "--arg", "-l"], "nothing would change"],
      [["edit", "Bash"], "give --name, --program, --arg or --clear-args"],
      [["edit", "Bash", "--arg", "-i", "--clear-args"], "give --arg or --clear-args, not both"],
      [["remove", "Bash", "--device", "Mac mini"], "--device is not taken here"],
    ] as const;
    for (const [argv, message] of tries) {
      const result = await nexus(made, ["terminal", "shells", ...argv]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
    expect(made.asked).toEqual([]);
    expect(shells().customShells).toEqual([BASH]);
  });

  it("removes the default shell as Settings does, saying new terminals fall back", async () => {
    useTerminalStore.getState().hydrateShells({
      customShells: [BASH],
      shell: { kind: "custom", id: BASH.id },
    });
    const made = app();
    made.answers.push("once");
    const removed = await nexus(made, ["terminal", "shells", "remove", "Bash"]);
    expect(removed.stdout).toBe(
      'Removed the shell "Bash". New terminals run the system\'s default shell.\n',
    );
    expect(made.asked.at(-1)?.change.settingsEdit?.lines).toEqual([
      { field: "program", to: "/bin/bash" },
      { field: "args", to: "-l" },
      { field: "defaultShell", from: "Bash" },
    ]);
    expect(shells()).toEqual({ customShells: [], shell: undefined });
  });

  it("saves nothing when the shells change while the user is asked", async () => {
    const made = app();
    const ask = made.services.askUser;
    made.services = {
      ...made.services,
      askUser: async (request, signal) => {
        useTerminalStore.getState().saveCustomShell({ ...BASH, path: "/bin/zsh" });
        return ask(request, signal);
      },
    };
    made.answers.push("once");
    const result = await nexus(made, ["terminal", "shells", "remove", "Bash"]);
    expect(result.stderr).toContain("the shells changed while waiting for the user's approval");
    expect(shells().customShells).toEqual([{ ...BASH, path: "/bin/zsh" }]);
  });
});

describe("the renderer's shell change", () => {
  it("only checks without approval, and refuses an approval for other shells", async () => {
    const plan = await change({ change: { op: "remove", shell: "Bash" } });
    expect(plan).toMatchObject({ shell: BASH, saved: false, wasDefault: false });
    expect(shells().customShells).toEqual([BASH]);
    await expect(
      change({ change: { op: "remove", shell: "Bash" }, approved: true, before: "[]" }),
    ).rejects.toThrow("the shells changed while waiting for the user's approval");
    await expect(
      change({ change: { op: "remove", shell: "Bash" }, approved: true }),
    ).rejects.toThrow("the shells changed while waiting for the user's approval");
    expect(shells().customShells).toEqual([BASH]);
    expect(writes).toEqual([]);
  });
});
