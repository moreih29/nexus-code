/**
 * Scenario tests for stash picker layout and modifier action routing.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createStashPickerSource,
  type StashPickItem,
} from "../../../../../../src/renderer/components/files/git/stash-picker-source";
import type { StashEntry } from "../../../../../../src/shared/types/git";

const workspaceId = "ws-stash";

function stash(overrides: Partial<StashEntry> = {}): StashEntry {
  return {
    index: 0,
    sha: "0123456789abcdef0123456789abcdef01234567",
    message: "save parser",
    branch: "main",
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

function buildSource(stashes: StashEntry[]) {
  const listStashes = mock(async () => stashes);
  const applyStash = mock(async () => true);
  const dropStash = mock(async () => true);
  const confirmDrop = mock(() => {});
  const source = createStashPickerSource({
    workspaceId,
    listStashes,
    applyStash,
    dropStash,
    confirmDrop,
  });
  return { source, listStashes, applyStash, dropStash, confirmDrop };
}

async function search(
  source: ReturnType<typeof createStashPickerSource>,
  query: string,
): Promise<readonly StashPickItem[]> {
  return source.search(query, new AbortController().signal);
}

describe("createStashPickerSource", () => {
  it("opens with searchOnEmptyQuery and formats stash rows", async () => {
    const { source } = buildSource([stash()]);

    expect(source.searchOnEmptyQuery).toBe(true);
    expect(source.emptyQueryMessage).toBe("Loading stashes…");
    expect(source.noResultsMessage).toBe("No matching stashes.");

    const items = await search(source, "");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "stash:0:0123456789abcdef0123456789abcdef01234567",
      label: "stash@{0} save parser",
      kindLabel: "main",
    });
    expect(items[0]?.description).toMatch(/ago|just now/);
  });

  it("filters by message, branch, and sha", async () => {
    const { source } = buildSource([
      stash({ index: 0, message: "frontend draft", branch: "ui" }),
      stash({
        index: 1,
        sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        message: "backend draft",
        branch: "api",
      }),
    ]);

    expect((await search(source, "front")).map((item) => item.stash.index)).toEqual([0]);
    expect((await search(source, "api")).map((item) => item.stash.index)).toEqual([1]);
    expect((await search(source, "abcdefabcdef")).map((item) => item.stash.index)).toEqual([1]);
  });

  it("routes Enter to apply, Cmd/Ctrl+Enter to pop, and Cmd/Ctrl+Backspace to confirm drop", async () => {
    const { source, applyStash, dropStash, confirmDrop } = buildSource([stash()]);
    const [item] = await search(source, "");
    if (!item) throw new Error("expected stash item");

    source.accept(item, { mode: "default", modifiers: noModifiers() });
    expect(applyStash).toHaveBeenCalledWith(workspaceId, 0);
    expect(dropStash).not.toHaveBeenCalled();

    source.accept(item, { mode: "side", modifiers: { ...noModifiers(), meta: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(applyStash).toHaveBeenCalledTimes(2);
    expect(dropStash).toHaveBeenCalledWith(workspaceId, 0);

    source.accept(item, { mode: "default", modifiers: { ...noModifiers(), ctrl: true } });
    expect(confirmDrop).toHaveBeenCalledWith(item);
  });
});

/** Returns the palette modifier object for a plain Enter accept. */
function noModifiers() {
  return { meta: false, ctrl: false, alt: false, shift: false };
}
