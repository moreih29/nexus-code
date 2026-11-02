/**
 * ClaudeReconnectCheck: a held terminal's Claude state, looked at again once
 * its output is replayed after the link comes back.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeReconnectCheck } from "../../../../src/main/features/claude/reconnect";
import { ClaudeStatusBroker } from "../../../../src/main/features/claude/status";

const WS = "ws-1";
const TAB = "tab-1";

const title = (text: string, end = "\x07") => `\x1b]0;${text}${end}`;

function setup(program: string | null = "claude") {
  const broker = new ClaudeStatusBroker(() => {});
  const changes: Array<string | null> = [];
  broker.onChange((_ws, _tab, entry) => changes.push(entry?.status ?? null));
  const foreground = { program, calls: 0 };
  const check = new ClaudeReconnectCheck(broker, async () => {
    foreground.calls += 1;
    return foreground.program;
  });
  return { broker, changes, check, foreground };
}

describe("ClaudeReconnectCheck", () => {
  test("a turn that ended while held: the replay's last title is idle, so it waits on the user", async () => {
    const { broker, changes, check } = setup();
    broker.set(WS, TAB, "running", undefined, "fix the build");
    changes.length = 0;

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, `${title("⠂ Fix the build")}working…`);
    check.noteReplay(WS, TAB, `done${title("✳ Fix the build", "\x1b\\")}`);
    expect(changes).toEqual([]);
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("needsInput");
    expect(broker.get(WS, TAB)?.prompt).toBe("fix the build");
    expect(changes).toEqual(["needsInput"]);
  });

  test("a title split across chunks still counts", async () => {
    const { broker, check } = setup();
    broker.set(WS, TAB, "running");

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, "output\x1b");
    check.noteReplay(WS, TAB, "]0;✳ Fi");
    check.noteReplay(WS, TAB, "x the build\x1b");
    check.noteReplay(WS, TAB, "\\more output");
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("needsInput");
  });

  test("still working: the last title is the spinner, so it stays running", async () => {
    const { broker, changes, check } = setup();
    broker.set(WS, TAB, "running");
    changes.length = 0;

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, `${title("✳ Claude Code")}${title("⠐ Fix the build")}`);
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("running");
    expect(changes).toEqual([]);
  });

  test("no title in the replay: nothing to go on, so it stays", async () => {
    const { broker, check } = setup();
    broker.set(WS, TAB, "running");

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, "plain output\r\n");
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("running");
  });

  test("a state that waits on the user already stays", async () => {
    const { broker, check } = setup();
    broker.set(WS, TAB, "permissionPending", "Bash");

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, title("✳ Fix the build"));
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("permissionPending");
  });

  test("Claude Code exited while held: the shell is back, so the state goes", async () => {
    for (const shell of ["zsh", "-bash"]) {
      const { broker, check } = setup(shell);
      broker.set(WS, TAB, "running");

      check.noteRestored(WS, TAB, true);
      check.noteReplay(WS, TAB, title("✳ Fix the build"));
      await check.noteReplayed(WS, TAB);

      expect(broker.get(WS, TAB)).toBeNull();
    }
  });

  test("an unknown foreground program clears nothing", async () => {
    const { broker, check, foreground } = setup(null);
    broker.set(WS, TAB, "idle");

    check.noteRestored(WS, TAB, true);
    await check.noteReplayed(WS, TAB);

    expect(foreground.calls).toBe(1);
    expect(broker.get(WS, TAB)?.status).toBe("idle");
  });

  test("a hook that came in after the terminal came back wins", async () => {
    const { broker, check, foreground } = setup("zsh");
    broker.set(WS, TAB, "running");

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, title("✳ Fix the build"));
    broker.set(WS, TAB, "completed", "Fixed it.");
    await check.noteReplayed(WS, TAB);

    expect(foreground.calls).toBe(0);
    expect(broker.get(WS, TAB)?.status).toBe("completed");
  });

  test("a hook that came in while the foreground program was looked up wins", async () => {
    const broker = new ClaudeStatusBroker(() => {});
    const check = new ClaudeReconnectCheck(broker, async () => {
      broker.set(WS, TAB, "completed", "Fixed it.");
      return "claude";
    });
    broker.set(WS, TAB, "running");

    check.noteRestored(WS, TAB, true);
    check.noteReplay(WS, TAB, title("✳ Fix the build"));
    await check.noteReplayed(WS, TAB);

    expect(broker.get(WS, TAB)?.status).toBe("completed");
  });

  test("a terminal with no Claude state, no replay, or that ended is left alone", async () => {
    const { broker, check, foreground } = setup("zsh");

    check.noteRestored(WS, TAB, true);
    await check.noteReplayed(WS, TAB);

    broker.set(WS, "tab-2", "running");
    check.noteRestored(WS, "tab-2", false);
    await check.noteReplayed(WS, "tab-2");

    broker.set(WS, "tab-3", "running");
    check.noteRestored(WS, "tab-3", true);
    check.forget(WS, "tab-3");
    await check.noteReplayed(WS, "tab-3");

    // A replay with no restore before it, as a renderer reload asks for.
    broker.set(WS, "tab-4", "running");
    check.noteReplay(WS, "tab-4", title("✳ Fix the build"));
    await check.noteReplayed(WS, "tab-4");

    expect(foreground.calls).toBe(0);
    expect(broker.get(WS, "tab-2")?.status).toBe("running");
    expect(broker.get(WS, "tab-3")?.status).toBe("running");
    expect(broker.get(WS, "tab-4")?.status).toBe("running");
  });
});
