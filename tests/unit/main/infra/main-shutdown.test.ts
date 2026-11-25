import { expect, jest, mock, test } from "bun:test";
import { createQuitStateFlush, finishMainShutdown } from "../../../../src/main/infra/main-shutdown";

test("quit proceeds after three failed state flush attempts", () => {
  jest.useFakeTimers();
  try {
    const flush = mock(() => {
      throw new Error("ENOSPC");
    });
    const preventDefault = mock(() => {});
    const warn = mock((_message: string) => {});
    const error = mock((_message: string) => {});
    const keep = mock(() => {});
    const quit = () => {
      if (flushBeforeQuit({ preventDefault })) finished = true;
    };
    let finished = false;
    const flushBeforeQuit = createQuitStateFlush({ flush, keep, quit, warn, error });
    quit();
    jest.advanceTimersByTime(1_999);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(finished).toBe(false);
    expect(keep).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(finished).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "Could not save app state before quit after 3 attempts: Error: ENOSPC; kept a copy for the next launch",
    );
    expect(keep).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});

test("quit reports a copy for the next launch that fails too", () => {
  const error = mock((_message: string) => {});
  const flushBeforeQuit = createQuitStateFlush(
    {
      flush: () => {
        throw new Error("EPERM");
      },
      keep: () => {
        throw new Error("ENOSPC");
      },
      quit: () => {},
      warn: () => {},
      error,
    },
    { setTimeout: () => undefined, clearTimeout: () => {} },
  );
  const event = { preventDefault: () => {} };
  expect(flushBeforeQuit(event)).toBe(false);
  expect(flushBeforeQuit(event)).toBe(false);
  expect(flushBeforeQuit(event)).toBe(true);
  expect(error.mock.calls).toEqual([
    [
      "Could not save app state before quit after 3 attempts: Error: EPERM; the copy for the next launch failed too: Error: ENOSPC",
    ],
  ]);
});

test("quit keeps no copy once a retried state flush succeeds", () => {
  let failures = 1;
  const keep = mock(() => {});
  const flushBeforeQuit = createQuitStateFlush(
    {
      flush: () => {
        if (failures-- > 0) throw new Error("EPERM");
      },
      keep,
      quit: () => {},
      warn: () => {},
      error: () => {},
    },
    { setTimeout: () => undefined, clearTimeout: () => {} },
  );
  const event = { preventDefault: () => {} };
  expect(flushBeforeQuit(event)).toBe(false);
  expect(flushBeforeQuit(event)).toBe(true);
  expect(keep).not.toHaveBeenCalled();
});

test("quit joins note writes and socket cleanup while letting LSP close before agents", async () => {
  const notes = Promise.withResolvers<void>();
  const helper = Promise.withResolvers<void>();
  const lsp = Promise.withResolvers<void>();
  const agents = Promise.withResolvers<void>();
  const waitForNotes = mock(() => notes.promise);
  const disposeGitHelpers = mock(() => helper.promise);
  const closeWorkspaces = mock(() => {});
  const waitForLocalAgents = mock(() => agents.promise);
  const warn = mock((_message: string) => {});
  let finished = false;
  const quit = finishMainShutdown(
    {
      waitForNotes,
      disposeGitHelpers,
      closeWorkspaces,
      waitForLocalAgents,
      warn,
      lspShutdown: lsp.promise,
    },
    3_000,
  ).then(() => {
    finished = true;
  });

  try {
    expect(waitForNotes).toHaveBeenCalledTimes(1);
    expect(disposeGitHelpers).toHaveBeenCalledTimes(1);
    expect(closeWorkspaces).not.toHaveBeenCalled();
    lsp.resolve();
    agents.resolve();
    notes.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeWorkspaces).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
  } finally {
    helper.resolve();
    lsp.resolve();
    agents.resolve();
    notes.resolve();
    await quit;
  }
  expect(warn).not.toHaveBeenCalled();
});

test("the remaining quit budget bounds stalled writes, cleanup and LSP together", async () => {
  jest.useFakeTimers();
  try {
    const stalled = Promise.withResolvers<void>();
    const closeWorkspaces = mock(() => {});
    const warn = mock((_message: string) => {});
    let finished = false;
    const quit = finishMainShutdown(
      {
        waitForNotes: () => stalled.promise,
        disposeGitHelpers: () => stalled.promise,
        lspShutdown: stalled.promise,
        closeWorkspaces,
        waitForLocalAgents: () => stalled.promise,
        warn,
      },
      2_000,
    ).then(() => {
      finished = true;
    });
    jest.advanceTimersByTime(1_999);
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(closeWorkspaces).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await quit;
    expect(closeWorkspaces).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("note writes, Git helper socket"));
    stalled.resolve();
  } finally {
    jest.useRealTimers();
  }
});
