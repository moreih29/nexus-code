import { describe, expect, mock, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { commandName, commandWaits } from "../../../../src/main/features/cli/registry";
import { RendererBridge } from "../../../../src/main/features/cli/renderer-bridge";
import { CLI_SLOW_MS, noteSlowRequest } from "../../../../src/main/features/cli/slow-log";
import { limitLog } from "../../../../src/shared/log/limit";
import { mainWarnMock } from "../../../log-test-spies";

function limited() {
  const warn = mock();
  return { warn, limited: limitLog({ error: mock(), warn, info: mock(), debug: mock() }) };
}

describe("command names", () => {
  test("a name is the command's words, never its arguments", () => {
    expect(commandName(CLI_COMMANDS, ["chat", "send", "tab-1", "my secret text"])).toBe(
      "chat send",
    );
    expect(commandName(CLI_COMMANDS, ["nope", "x"])).toBe("unknown");
  });

  test("wait commands and --wait are marked as waiting", () => {
    expect(commandWaits(CLI_COMMANDS, ["chat", "wait", "t"])).toBe(true);
    expect(commandWaits(CLI_COMMANDS, ["chat", "send", "t", "--wait"])).toBe(true);
    expect(commandWaits(CLI_COMMANDS, ["chat", "send", "t", "hi"])).toBe(false);
  });
});

describe("slow nexus requests", () => {
  test("under the limit or waiting by design writes nothing", () => {
    const { warn, limited: l } = limited();
    noteSlowRequest(l, "chat send", false, CLI_SLOW_MS);
    noteSlowRequest(l, "chat wait", true, 600_000);
    expect(warn).not.toHaveBeenCalled();
  });

  test("over the limit writes the name and time, and repeats are limited", () => {
    const { warn, limited: l } = limited();
    noteSlowRequest(l, "chat send", false, 6200);
    noteSlowRequest(l, "chat send", false, 7000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("cli request was slow: command=chat send ms=6200");
  });
});

describe("renderer bridge timeout", () => {
  test("logs the op and the wait, not the arguments", async () => {
    mainWarnMock.mockClear();
    const bridge = new RendererBridge(() => ({ webContents: { send: () => {}, focus: () => {} } }));
    const asked = (bridge as any).ask("focusTab", { tabId: "private-tab-name" }, 5);
    await expect(asked).rejects.toThrow("did not answer");
    const line = String(mainWarnMock.mock.calls.at(-1)?.[0]);
    expect(line).toBe("the window did not answer a cli request: op=focusTab waited=5ms");
    expect(line).not.toContain("private");
  });
});
