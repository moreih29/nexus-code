import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { FileMatch, SearchComplete } from "../../../src/shared/search/types";
import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../helpers/ipc-pair";

beforeEach(resetInMemoryIpc);
afterEach(resetInMemoryIpc);

test("destroying one renderer aborts its pending call and leaves another renderer's call alone", async () => {
  const { register } = await setupInMemoryRouter();
  const first = Promise.withResolvers<AbortSignal>();
  const second = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  register("call-lifetime", {
    call: {
      wait: async (args, ctx) => {
        (args === "first" ? first : second).resolve(ctx!.signal!);
        await finish.promise;
      },
    },
    listen: {},
  });
  const pair = createIpcPair();
  const other = createIpcPair();
  const pending = pair.window.ipc.call("call-lifetime", "wait", "first", "req");
  const unrelated = other.window.ipc.call("call-lifetime", "wait", "second", "req");
  try {
    const [signal, otherSignal] = await Promise.all([first.promise, second.promise]);
    pair.sender.destroy();
    expect(signal.aborted).toBe(true);
    expect(otherSignal.aborted).toBe(false);
  } finally {
    finish.resolve();
    await Promise.all([pending, unrelated]);
  }
});

test("a stream opened after its renderer dies is closed without starting it", async () => {
  const { register } = await setupInMemoryRouter();
  const entered = Promise.withResolvers<AbortSignal>();
  const complete = { filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 };
  const generator = Promise.withResolvers<AsyncGenerator<FileMatch[], SearchComplete>>();
  const iterator = Object.assign(
    (async function* () {
      yield [] as FileMatch[];
      return complete;
    })(),
    { return: mock(async () => ({ done: true as const, value: complete })) },
  );
  register("fs", {
    call: {},
    listen: {},
    stream: {
      searchText: async (_args, ctx) => {
        entered.resolve(ctx.signal);
        return generator.promise;
      },
    },
  });
  const pair = createIpcPair();
  await pair.window.ipc.streamStart("fs", "searchText", {
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    query: { pattern: "needle" },
  });
  const signal = await entered.promise;
  pair.sender.destroy();

  generator.resolve(iterator);
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(signal.aborted).toBe(true);
  expect(iterator.return).toHaveBeenCalledTimes(1);
  expect(pair.sender.streamEvents).toEqual([]);
});
