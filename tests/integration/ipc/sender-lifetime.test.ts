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

test("a call without a caller ID is cancelled on renderer destruction while a durable save finishes", async () => {
  const { register } = await setupInMemoryRouter();
  const signals = new Map<string, AbortSignal | undefined>();
  const finish = Promise.withResolvers<void>();
  register("owner-lifetime", {
    keepOnRendererClose: ["save"],
    call: {
      load: async (_args, ctx) => {
        signals.set("load", ctx?.signal);
        await finish.promise;
      },
      save: async (_args, ctx) => {
        signals.set("save", ctx?.signal);
        await finish.promise;
        return "saved";
      },
    },
    listen: {},
  });
  const pair = createIpcPair();
  const load = pair.window.ipc.call("owner-lifetime", "load", undefined);
  const save = pair.window.ipc.call("owner-lifetime", "save", undefined);
  try {
    pair.sender.destroy();
    expect(signals.get("load")?.aborted).toBe(true);
    expect(signals.get("save")?.aborted).toBe(false);
  } finally {
    finish.resolve();
    await load;
    expect(await save).toBe("saved");
  }
});

test("the pre-cancellation cache retains only the newest 1024 request IDs", async () => {
  const { register } = await setupInMemoryRouter();
  register("cancel-limit", {
    call: { check: (_args, ctx) => ctx?.signal?.aborted },
    listen: {},
  });
  const pair = createIpcPair();
  for (let i = 0; i <= 1024; i += 1) pair.window.ipc.cancel(`limit-${i}`);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-0")).toBe(false);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-1")).toBe(true);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-1024")).toBe(true);
  await Promise.all(
    Array.from({ length: 1022 }, (_, index) =>
      pair.window.ipc.call("cancel-limit", "check", undefined, `limit-${index + 2}`),
    ),
  );
});

test("unknown stream channels and methods return an invalid-input result", async () => {
  const { register } = await setupInMemoryRouter();
  register("fs", { call: {}, listen: {} });
  const pair = createIpcPair();
  for (const [channel, method] of [
    ["missing", "searchText"],
    ["fs", "constructor"],
  ] as const) {
    await expect(pair.window.ipc.streamStart(channel, method, undefined)).resolves.toMatchObject({
      ok: false,
      kind: "invalid-args",
      category: "invalid-input",
    });
  }
  expect(pair.sender.streamEvents).toEqual([]);
});
