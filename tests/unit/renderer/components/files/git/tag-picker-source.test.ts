/**
 * Scenario tests for tag picker mode filters and accept routing.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createTagPickerSource,
  type TagPickerMode,
  type TagPickItem,
} from "../../../../../../src/renderer/components/files/git/tag-picker-source";
import type { RemoteTag, Tag } from "../../../../../../src/shared/types/git";

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

function remoteTag(overrides: Partial<RemoteTag> = {}): RemoteTag {
  return {
    remote: "origin",
    name: "v1.0.0",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: "remote",
    ...overrides,
  };
}

function buildSource(
  tags: Tag[],
  options: {
    mode?: TagPickerMode;
    remoteTags?: RemoteTag[];
    selectedRemote?: string | null;
  } = {},
) {
  const listTags = mock(async () => tags);
  const listRemoteTags = mock(async () => options.remoteTags ?? []);
  const revealTag = mock(() => {});
  const requestCreate = mock(() => {});
  const requestDelete = mock(() => {});
  const source = createTagPickerSource({
    workspaceId,
    mode: options.mode,
    selectedRemote: options.selectedRemote,
    listTags,
    listRemoteTags,
    revealTag,
    requestCreate,
    requestDelete,
  });
  return { source, listTags, listRemoteTags, revealTag, requestCreate, requestDelete };
}

async function search(
  source: ReturnType<typeof createTagPickerSource>,
  query: string,
): Promise<readonly TagPickItem[]> {
  return source.search(query, new AbortController().signal);
}

describe("createTagPickerSource", () => {
  it("opens browse mode with searchOnEmptyQuery and formats create/tag rows", async () => {
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
    expect(source.title).toBe("Tags");
    expect(source.placeholder).toBe("Search tags or type a name to create…");

    const items = await search(source, "");
    expect(items.map((item) => item.label)).toEqual(["Create tag…", "snapshot", "v1.0.0"]);
    expect(items[1]).toMatchObject({ kind: "tag", kindLabel: "lightweight", scope: "local" });
    expect(items[2]).toMatchObject({ kind: "tag", kindLabel: "annotated", scope: "local" });
  });

  it("filters browse tags and carries a typed query into the create row", async () => {
    const { source } = buildSource([
      tag({ name: "release-1" }),
      tag({ name: "nightly", message: null }),
    ]);

    const items = await search(source, "rel");

    expect(items.map((item) => item.label)).toEqual(["Create tag: 'rel'", "release-1"]);
    expect(items[0]).toMatchObject({ kind: "create", defaultName: "rel" });
  });

  it("routes browse Enter to reveal and create row to requestCreate", async () => {
    const { source, revealTag, requestDelete, requestCreate } = buildSource([tag()]);
    const items = await search(source, "");
    const createItem = items[0]!;
    const tagItem = items.find((item) => item.kind === "tag");
    if (!tagItem) throw new Error("expected tag item");

    source.accept(createItem, { mode: "default", modifiers: noModifiers() });
    expect(requestCreate).toHaveBeenCalledWith(undefined);

    source.accept(tagItem, { mode: "default", modifiers: noModifiers(), key: "Enter" });
    expect(revealTag).toHaveBeenCalledWith(tagItem);

    expect(requestDelete).not.toHaveBeenCalled();
  });

  it("keeps create mode tags read-only while typed queries enable the create row", async () => {
    const { source, revealTag, requestCreate, requestDelete } = buildSource(
      [tag(), tag({ name: "v2.0.0", message: null })],
      { mode: "create" },
    );

    expect(source.title).toBe("Create a new tag");
    expect(source.placeholder).toBe("Type a tag name to create…");
    expect(source.noResultsMessage).toBe("Type to create your first tag");

    const items = await search(source, "v1.0.0");
    const createItem = items.find((item) => item.kind === "create");
    const existingItem = items.find((item) => item.kind === "tag");

    expect(items.map((item) => item.label)).toEqual(["Create tag: 'v1.0.0'", "v1.0.0"]);
    expect(existingItem).toMatchObject({ kindLabel: "exists", detail: "Already exists · release" });

    if (!createItem || !existingItem) throw new Error("expected create and tag items");
    source.accept(createItem, { mode: "default", modifiers: noModifiers() });
    source.accept(existingItem, { mode: "default", modifiers: noModifiers() });

    expect(requestCreate).toHaveBeenCalledWith("v1.0.0");
    expect(revealTag).not.toHaveBeenCalled();
    expect(requestDelete).not.toHaveBeenCalled();
  });

  it("uses local-only tags for delete-local mode and exposes destructive tone", async () => {
    const { source, requestDelete, revealTag, requestCreate, listRemoteTags } = buildSource(
      [tag({ name: "local" })],
      { mode: "delete-local", remoteTags: [remoteTag()] },
    );

    expect(source.title).toBe("Select a tag to delete");
    expect(source.placeholder).toBe("Search local tags…");
    expect(source.noResultsMessage).toBe("No tags to delete");

    const items = await search(source, "");
    expect(items.map((item) => item.label)).toEqual(["local"]);
    expect(items[0]).toMatchObject({
      kind: "tag",
      kindLabel: "delete",
      detail: "Local tag · release",
      tone: "destructive",
    });
    expect(listRemoteTags).not.toHaveBeenCalled();

    const tagItem = items[0];
    if (!tagItem || tagItem.kind !== "tag") throw new Error("expected local tag item");
    source.accept(tagItem, { mode: "default", modifiers: noModifiers() });

    expect(requestDelete).toHaveBeenCalledWith(tagItem, { kind: "local" });
    expect(revealTag).not.toHaveBeenCalled();
    expect(requestCreate).not.toHaveBeenCalled();
  });

  it("uses only selected-remote rows for delete-remote mode and routes remote deletion", async () => {
    const origin = remoteTag();
    const upstream = remoteTag({ remote: "upstream", name: "v2.0.0" });
    const { source, requestDelete, revealTag, requestCreate, listTags, listRemoteTags } =
      buildSource([tag({ name: "local-only" })], {
        mode: "delete-remote",
        selectedRemote: "origin",
        remoteTags: [origin, upstream],
      });

    expect(source.title).toBe("Select a remote tag to delete");
    expect(source.placeholder).toBe("Search remote tags…");
    expect(source.noResultsMessage).toBe("No remote tags to delete");

    const items = await search(source, "origin");
    expect(listTags).not.toHaveBeenCalled();
    expect(listRemoteTags).toHaveBeenCalledWith(workspaceId, "origin", expect.any(AbortSignal));
    expect(items.map((item) => item.label)).toEqual(["origin/v1.0.0"]);
    expect(items[0]).toMatchObject({
      kind: "tag",
      kindLabel: "delete",
      scope: "remote",
      remote: "origin",
      detail: "Remote origin · aaaaaaa",
      tone: "destructive",
    });

    const tagItem = items[0];
    if (!tagItem || tagItem.kind !== "tag") throw new Error("expected remote tag item");
    source.accept(tagItem, { mode: "default", modifiers: noModifiers() });

    expect(requestDelete).toHaveBeenCalledWith(tagItem, { kind: "remote", remote: "origin" });
    expect(revealTag).not.toHaveBeenCalled();
    expect(requestCreate).not.toHaveBeenCalled();
  });

  it("keeps delete-remote empty without a selected remote and does not fall back to local tags", async () => {
    const { source, listTags, listRemoteTags } = buildSource([tag()], { mode: "delete-remote" });

    expect(await search(source, "")).toEqual([]);
    expect(listTags).not.toHaveBeenCalled();
    expect(listRemoteTags).not.toHaveBeenCalled();
  });
});

/** Returns the palette modifier object for a plain Enter accept. */
function noModifiers() {
  return { meta: false, ctrl: false, alt: false, shift: false };
}
