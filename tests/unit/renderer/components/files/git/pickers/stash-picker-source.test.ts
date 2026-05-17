/**
 * Scenario tests for stash picker layout and accept routing.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createStashPickerSource,
  type StashPickItem,
} from "../../../../../../../src/renderer/components/files/git/pickers/stash-picker-source";
import type { StashEntry } from "../../../../../../../src/shared/git/types";

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
  const source = createStashPickerSource({
    workspaceId,
    listStashes,
    applyStash,
  });
  return { source, listStashes, applyStash };
}

function buildDropSource(stashes: StashEntry[]) {
  const listStashes = mock(async () => stashes);
  const applyStash = mock(async () => true);
  const requestDrop = mock((_item: StashPickItem) => {});
  const source = createStashPickerSource({
    workspaceId,
    mode: "drop",
    listStashes,
    applyStash,
    requestDrop,
  });
  return { source, listStashes, applyStash, requestDrop };
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

  it("routes Enter to apply regardless of modifiers", async () => {
    const { source, applyStash } = buildSource([stash()]);
    const [item] = await search(source, "");
    if (!item) throw new Error("expected stash item");

    source.accept(item, { mode: "default", modifiers: noModifiers() });
    expect(applyStash).toHaveBeenCalledWith(workspaceId, 0);

    source.accept(item, { mode: "side", modifiers: { ...noModifiers(), meta: true } });
    expect(applyStash).toHaveBeenCalledTimes(2);
  });
});

describe("createStashPickerSource — drop mode", () => {
  it("uses drop-specific title and placeholder", () => {
    const { source } = buildDropSource([stash()]);

    expect(source.title).toBe("Drop Stash");
    expect(source.placeholder).toBe("Select a stash to drop…");
  });

  it("routes Enter to requestDrop instead of applyStash in drop mode", async () => {
    const { source, applyStash, requestDrop } = buildDropSource([stash()]);
    const [item] = await source.search("", new AbortController().signal);
    if (!item) throw new Error("expected stash item");

    source.accept(item, { mode: "default", modifiers: noModifiers() });

    expect(requestDrop).toHaveBeenCalledTimes(1);
    expect(requestDrop).toHaveBeenCalledWith(item);
    expect(applyStash).not.toHaveBeenCalled();
  });

  it("does not call requestDrop when it is not provided", async () => {
    // Safety: if caller forgets requestDrop in drop mode, accept must not throw.
    const listStashes = mock(async () => [stash()]);
    const applyStash = mock(async () => true);
    const source = createStashPickerSource({
      workspaceId,
      mode: "drop",
      listStashes,
      applyStash,
      // requestDrop intentionally omitted
    });
    const [item] = await source.search("", new AbortController().signal);
    if (!item) throw new Error("expected stash item");

    // Must not throw
    expect(() => source.accept(item)).not.toThrow();
    expect(applyStash).not.toHaveBeenCalled();
  });

  it("apply mode still routes Enter to applyStash", async () => {
    const { source, applyStash } = buildSource([stash()]);
    const [item] = await source.search("", new AbortController().signal);
    if (!item) throw new Error("expected stash item");

    source.accept(item, { mode: "default", modifiers: noModifiers() });

    expect(applyStash).toHaveBeenCalledTimes(1);
    expect(applyStash).toHaveBeenCalledWith(workspaceId, 0);
  });
});

/** Returns the palette modifier object for a plain Enter accept. */
function noModifiers() {
  return { meta: false, ctrl: false, alt: false, shift: false };
}
