/**
 * Scenario tests for tag picker layout and modifier action routing.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createTagPickerSource,
  type TagPickItem,
} from "../../../../../../src/renderer/components/files/git/tag-picker-source";
import type { Tag } from "../../../../../../src/shared/types/git";

const workspaceId = "ws-tags";

function tag(overrides: Partial<Tag> = {}): Tag {
  return {
    name: "v1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
    message: "release",
    type: "annotated",
    taggerDate: Date.now() - 60_000,
    ...overrides,
  };
}

function buildSource(tags: Tag[]) {
  const listTags = mock(async () => tags);
  const revealTag = mock(() => {});
  const requestCreate = mock(() => {});
  const requestDelete = mock(() => {});
  const source = createTagPickerSource({
    workspaceId,
    listTags,
    revealTag,
    requestCreate,
    requestDelete,
  });
  return { source, listTags, revealTag, requestCreate, requestDelete };
}

async function search(
  source: ReturnType<typeof createTagPickerSource>,
  query: string,
): Promise<readonly TagPickItem[]> {
  return source.search(query, new AbortController().signal);
}

describe("createTagPickerSource", () => {
  it("opens with searchOnEmptyQuery and formats create/tag rows", async () => {
    const { source } = buildSource([
      tag(),
      tag({
        name: "snapshot",
        message: null,
        type: "lightweight",
        taggerDate: null,
      }),
    ]);

    expect(source.id).toBe("git.tag-picker");
    expect(source.searchOnEmptyQuery).toBe(true);

    const items = await search(source, "");
    expect(items.map((item) => item.label)).toEqual(["Create tag…", "snapshot", "v1.0.0"]);
    expect(items[1]).toMatchObject({ kind: "tag", kindLabel: "lightweight" });
    expect(items[2]).toMatchObject({ kind: "tag", kindLabel: "annotated" });
  });

  it("filters tags and carries a typed query into the create row", async () => {
    const { source } = buildSource([
      tag({ name: "release-1" }),
      tag({ name: "nightly", message: null }),
    ]);

    const items = await search(source, "rel");

    expect(items.map((item) => item.label)).toEqual(["Create tag: 'rel'", "release-1"]);
    expect(items[0]).toMatchObject({ kind: "create", defaultName: "rel" });
  });

  it("routes Enter reveal, Cmd/Ctrl+Backspace delete, and Shift+Cmd/Ctrl+Backspace delete-remote", async () => {
    const { source, revealTag, requestDelete, requestCreate } = buildSource([tag()]);
    const items = await search(source, "");
    const createItem = items[0]!;
    const tagItem = items.find((item) => item.kind === "tag");
    if (!tagItem) throw new Error("expected tag item");

    source.accept(createItem, { mode: "default", modifiers: noModifiers() });
    expect(requestCreate).toHaveBeenCalledWith(undefined);

    source.accept(tagItem, { mode: "default", modifiers: noModifiers(), key: "Enter" });
    expect(revealTag).toHaveBeenCalledWith(tagItem);

    source.accept(tagItem, {
      mode: "default",
      modifiers: { ...noModifiers(), ctrl: true },
      key: "Backspace",
    });
    expect(requestDelete).toHaveBeenCalledWith(tagItem, false);

    source.accept(tagItem, {
      mode: "default",
      modifiers: { ...noModifiers(), meta: true, shift: true },
      key: "Backspace",
    });
    expect(requestDelete).toHaveBeenCalledWith(tagItem, true);
  });
});

/** Returns the palette modifier object for a plain Enter accept. */
function noModifiers() {
  return { meta: false, ctrl: false, alt: false, shift: false };
}
