import { expect, jest, mock, test } from "bun:test";
import { finishMainShutdown } from "../../../../src/main/infra/main-shutdown";

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
