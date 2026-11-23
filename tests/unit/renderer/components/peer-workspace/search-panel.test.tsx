import { expect, spyOn, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcResult } from "../../../../../packages/remote-protocol/src/rpc";
import { SearchInput } from "../../../../../src/renderer/components/files/search/input";
import { SearchResultsList } from "../../../../../src/renderer/components/files/search/results-list";
import { SearchFailedMessage } from "../../../../../src/renderer/components/files/search/state-messages";
import { PeerSearchPanel } from "../../../../../src/renderer/components/peer-workspace/search-panel";
import * as ipc from "../../../../../src/renderer/ipc/client";
import type { PeerWorkspaceTarget } from "../../../../../src/renderer/state/stores/peer-workspace";
import { type IpcResult, ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "device",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "workspace",
  workspace: { id: "workspace", name: "Workspace", path: "/home/demo" },
};

type SearchReply = IpcResult<RpcResult<"files.search">>;

function reply(path: string, truncated = false): SearchReply {
  return ipcOk({
    files: [{ path, matches: [{ line: 1, column: 0, length: 1, text: "x" }] }],
    truncated,
  });
}

function findChild<P extends { children?: React.ReactNode }>(
  node: React.ReactNode,
  type: React.ElementType,
): React.ReactElement<P> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findChild<P>(child, type);
      if (match) return match;
    }
  }
  if (!React.isValidElement<P>(node)) return undefined;
  return node.type === type ? node : findChild<P>(node.props.children, type);
}

// Drives the real panel's handlers and state without a browser DOM. The
// markup assertions render its returned element with React's server renderer.
function mountPanel() {
  const hooks: unknown[] = [];
  let cursor = 0;
  const dispatcher = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[index],
        (next: unknown) => {
          hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useContext: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useEffect: () => {},
    useDebugValue: () => {},
  };
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: typeof dispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  function render() {
    const previous = internals.H;
    cursor = 0;
    internals.H = dispatcher;
    try {
      return PeerSearchPanel({ target, canRead: true, rejoin: 0 });
    } finally {
      internals.H = previous;
    }
  }

  return {
    input: () =>
      findChild<React.ComponentProps<typeof SearchInput> & { children?: React.ReactNode }>(
        render(),
        SearchInput,
      )!.props,
    paths: () =>
      findChild<React.ComponentProps<typeof SearchResultsList> & { children?: React.ReactNode }>(
        render(),
        SearchResultsList,
      )?.props.results.map((group) => group.relPath) ?? [],
    failed: () =>
      findChild<React.ComponentProps<typeof SearchFailedMessage> & { children?: React.ReactNode }>(
        render(),
        SearchFailedMessage,
      )?.props,
    markup: () => renderToStaticMarkup(render()),
  };
}

test("a new peer search aborts the old request and only shows results for the current query", async () => {
  const first = Promise.withResolvers<SearchReply>();
  const second = Promise.withResolvers<SearchReply>();
  const third = Promise.withResolvers<SearchReply>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => third.promise);
  try {
    const panel = mountPanel();
    panel.input().onChange("first");
    panel.input().onEnter();
    expect(panel.markup().match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain(
      ' disabled=""',
    );

    panel.input().onChange("second");
    panel.input().onEnter();
    expect(call.mock.calls[0][3]?.signal?.aborted).toBe(true);
    expect(call.mock.calls[1][2]).toMatchObject({ query: "second" });
    panel.input().onEnter();
    expect(call.mock.calls[1][3]?.signal?.aborted).toBe(true);

    third.resolve(reply("current.ts", true));
    await third.promise;
    expect(panel.paths()).toEqual(["current.ts"]);
    expect(panel.markup()).toContain("Partial results");

    first.resolve(reply("old.ts"));
    second.resolve(ipcErr("unsupported", "MethodNotFound"));
    await Promise.all([first.promise, second.promise]);
    expect(panel.paths()).toEqual(["current.ts"]);
    expect(panel.markup()).not.toContain("App update needed");
    panel.input().onChange("third");
    expect(panel.paths()).toEqual([]);
  } finally {
    call.mockRestore();
  }
});

test("an unsupported peer search shows the update message and disables further submissions", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
    ipcErr("unsupported", "MethodNotFound"),
  );
  try {
    const panel = mountPanel();
    panel.input().onChange("test");
    panel.input().onEnter();
    await Promise.resolve();
    const markup = panel.markup();
    expect(markup).toContain("App update needed on that computer");
    expect(markup.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain(' disabled=""');
    panel.input().onChange("changed");
    panel.input().onEnter();
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    call.mockRestore();
  }
});

test("peer search shows a bounded regexp diagnostic and localizes other failures", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcErr("unavailable", "Invalid search pattern has internal detail"))
    .mockResolvedValueOnce(
      ipcErr(
        "unavailable",
        `Invalid search pattern "(?=x)": error parsing regexp: ${"x".repeat(1000)}`,
      ),
    );
  try {
    const panel = mountPanel();
    panel.input().onChange("test");
    panel.input().onEnter();
    await Promise.resolve();
    expect(panel.markup()).toContain("Disconnected on that computer");
    expect(panel.markup()).not.toContain("internal detail");

    panel.input().onEnter();
    await Promise.resolve();
    const markup = panel.markup();
    expect(markup).toContain("regular expression:");
    expect(markup).toContain(`${"x".repeat(255)}…`);
    expect(markup).not.toContain("x".repeat(256));
  } finally {
    call.mockRestore();
  }
});

test("peer search filters and the submit action have separate rows", () => {
  const markup = mountPanel().markup();
  expect(markup).toMatch(
    /<div class="flex flex-col [^"]*"><details[^>]*><summary[^>]*whitespace-nowrap[^>]*>Search filters<svg.*?<\/svg><\/summary>.*?<\/details><button[^>]*type="submit"/,
  );
});

test("peer search filters open in place, with no platform triangle: a chevron down after their name", () => {
  const summary = mountPanel()
    .markup()
    .match(/<summary([^>]*)>(.*?)<\/summary>/);
  expect(summary?.[1]).toContain("list-none");
  expect(summary?.[2]).toMatch(/^Search filters<svg[^>]*lucide-chevron-down/);
});

test("peer search says what the local one says: before a search, with nothing found, and on a failure", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk({ files: [], truncated: false }))
    .mockResolvedValueOnce(ipcErr("unavailable", "gone"))
    .mockResolvedValueOnce(ipcOk({ files: [], truncated: false }));
  try {
    const panel = mountPanel();
    expect(panel.markup()).toContain("Search across workspace");
    panel.input().onChange("test");
    expect(panel.markup()).not.toContain("Search across workspace");
    panel.input().onEnter();
    await Promise.resolve();
    expect(panel.markup()).toContain("No results found");
    expect(panel.markup()).toContain("Try a different search term.");

    panel.input().onEnter();
    await Promise.resolve();
    expect(panel.markup()).toContain("Retry");
    panel.failed()?.onRetry?.();
    expect(call).toHaveBeenCalledTimes(3);
  } finally {
    call.mockRestore();
  }
});

test("an unsupported peer search offers no retry", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
    ipcErr("unsupported", "MethodNotFound"),
  );
  try {
    const panel = mountPanel();
    panel.input().onChange("test");
    panel.input().onEnter();
    await Promise.resolve();
    expect(panel.failed()?.onRetry).toBeUndefined();
    expect(panel.markup()).not.toContain("Retry");
  } finally {
    call.mockRestore();
  }
});
