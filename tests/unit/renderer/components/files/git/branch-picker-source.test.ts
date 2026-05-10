/**
 * BranchPickerSource — VS Code "Checkout to..." quick-pick parity.
 *
 * Focus:
 *   (a) Empty query lists current first, then other locals, then de-duplicated
 *       remotes (short name only, hidden when local already exists).
 *   (b) Selecting a remote-only entry calls `checkout(workspaceId, <short>)`,
 *       not the full `origin/<short>` ref. This guards the path that previously
 *       sent `origin/main` straight to git and produced
 *       `pathspec '<short>' did not match` confusion when a local copy
 *       did not exist.
 *   (c) Typed query supports both short-name match (`main`) and full-ref match
 *       (`origin/main`) on remotes.
 *   (d) Create-new entry only appears when the query is non-empty AND no local
 *       or remote-short exact match exists; create action calls
 *       `createBranch(workspaceId, name, true)`.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  type BranchPickItem,
  createBranchPickerSource,
} from "../../../../../../src/renderer/components/files/git/branch-picker-source";
import type { BranchList } from "../../../../../../src/shared/types/git";

function fixture(overrides: Partial<BranchList> = {}): BranchList {
  return {
    current: {
      current: "feat/work",
      upstream: null,
      ahead: 0,
      behind: 0,
      isUnborn: false,
    },
    local: ["feat/work"],
    remote: [],
    ...overrides,
  };
}

function buildSource(list: BranchList): {
  source: ReturnType<typeof createBranchPickerSource>;
  checkout: ReturnType<typeof mock>;
  checkoutTracking: ReturnType<typeof mock>;
  createBranch: ReturnType<typeof mock>;
  requestDelete: ReturnType<typeof mock>;
  requestRename: ReturnType<typeof mock>;
  requestSetUpstream: ReturnType<typeof mock>;
} {
  const checkout = mock(async () => {});
  const checkoutTracking = mock(async () => {});
  const createBranch = mock(async () => {});
  const requestDelete = mock(() => {});
  const requestRename = mock(() => {});
  const requestSetUpstream = mock(() => {});
  const source = createBranchPickerSource({
    workspaceId: "ws-1",
    listBranches: async () => list,
    checkout,
    checkoutTracking,
    createBranch,
    requestDelete,
    requestRename,
    requestSetUpstream,
  });
  return {
    source,
    checkout,
    checkoutTracking,
    createBranch,
    requestDelete,
    requestRename,
    requestSetUpstream,
  };
}

async function search(
  source: ReturnType<typeof createBranchPickerSource>,
  query: string,
): Promise<readonly BranchPickItem[]> {
  return source.search(query, new AbortController().signal);
}

describe("createBranchPickerSource — empty query layout", () => {
  it("opens with current branch first, then other locals, then deduped remotes", async () => {
    const { source } = buildSource(
      fixture({
        local: ["feat/work", "main", "stable"],
        remote: ["origin/main", "origin/stable", "origin/dev"],
        // dev exists only as remote → should appear (short name) once
        // main / stable exist locally → remote duplicates hidden
      }),
    );

    const items = await search(source, "");
    const labels = items.map((it) => it.label);
    expect(labels).toEqual(["feat/work", "main", "stable", "dev"]);

    expect(items[0]?.kindLabel).toBe("current");
    expect(items[3]?.description).toBe("Remote origin/dev");
  });

  it("shows remotes by short name with a checkout-tracking action carrying the full ref", async () => {
    const { source } = buildSource(
      fixture({
        local: ["feat/work"],
        remote: ["origin/main"],
      }),
    );

    const items = await search(source, "");
    const remote = items.find((it) => it.id === "remote:origin/main");
    expect(remote).toBeDefined();
    expect(remote?.label).toBe("main");
    if (remote?.action.kind !== "checkout-tracking") {
      throw new Error("expected checkout-tracking action");
    }
    expect(remote.action.remoteRef).toBe("origin/main"); // full, not short
  });

  it("dedupes when multiple remotes provide the same short name (first wins)", async () => {
    const { source } = buildSource(
      fixture({
        local: ["feat/work"],
        remote: ["origin/main", "fork/main"],
      }),
    );

    const items = await search(source, "");
    const remoteHits = items.filter((it) => it.id.startsWith("remote:"));
    expect(remoteHits).toHaveLength(1);
    expect(remoteHits[0]?.label).toBe("main");
  });

  it("does not include a Create row when the query is empty", async () => {
    const { source } = buildSource(fixture({ local: ["feat/work"], remote: [] }));
    const items = await search(source, "");
    expect(items.some((it) => it.id.startsWith("create:"))).toBe(false);
  });

  it("hides the unborn current branch from local items so checkout cannot fire on it", async () => {
    // The unborn branch name comes from `git status -b` but is absent
    // from `git branch --list` until the first commit. Showing it as a
    // clickable `checkout` item produced "Branch 'main' does not exist
    // locally or on any remote." in production; the picker now omits it
    // and relies on the panel's unborn banner to convey the state.
    const { source } = buildSource(
      fixture({
        current: {
          current: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          isUnborn: true,
        },
        local: [],
        remote: [],
      }),
    );
    const items = await search(source, "");
    expect(items.find((it) => it.id === "local:main")).toBeUndefined();
    expect(items).toHaveLength(0);
  });
});

describe("createBranchPickerSource — typed query filtering", () => {
  it("matches remotes by short name", async () => {
    const { source } = buildSource(
      fixture({
        local: ["feat/work"],
        remote: ["origin/main", "origin/dev"],
      }),
    );

    const items = await search(source, "mai");
    const labels = items.map((it) => it.label);
    expect(labels).toContain("main");
    expect(labels).not.toContain("dev");
  });

  it("matches remotes by full ref too (typing 'origin/' surfaces the remote group)", async () => {
    const { source } = buildSource(
      fixture({
        local: ["feat/work"],
        remote: ["origin/main"],
      }),
    );

    const items = await search(source, "origin/");
    const remote = items.find((it) => it.id === "remote:origin/main");
    expect(remote).toBeDefined();
    expect(remote?.label).toBe("main");
  });
});

describe("createBranchPickerSource — Create new branch row", () => {
  it("appears for non-empty query with no exact local or remote-short match", async () => {
    const { source } = buildSource(fixture({ local: ["feat/work"], remote: [] }));
    const items = await search(source, "scratch");
    const createRow = items.find((it) => it.id === "create:scratch");
    expect(createRow).toBeDefined();
    expect(createRow?.label).toBe("Create new branch: 'scratch'");
    expect(createRow?.ariaLabel).toBe("Create new branch scratch");
  });

  it("uses the rename-unborn label when the current branch is unborn", async () => {
    // `git checkout -b X` on an unborn HEAD silently re-points the symbolic
    // ref, so the previous branch name vanishes. The label has to show the
    // user what they are signing up for before they click.
    const { source } = buildSource(
      fixture({
        current: {
          current: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          isUnborn: true,
        },
        local: [],
        remote: [],
      }),
    );
    const items = await search(source, "scratch");
    const createRow = items.find((it) => it.id === "create:scratch");
    expect(createRow).toBeDefined();
    expect(createRow?.label).toBe("Rename unborn 'main' → 'scratch'");
    expect(createRow?.ariaLabel).toBe("Rename unborn main to scratch");
  });

  it("is suppressed when the typed name exactly matches an existing local branch", async () => {
    const { source } = buildSource(fixture({ local: ["feat/work", "main"], remote: [] }));
    const items = await search(source, "main");
    expect(items.some((it) => it.id.startsWith("create:"))).toBe(false);
  });

  it("is suppressed when the typed name exactly matches a remote short name", async () => {
    const { source } = buildSource(fixture({ local: ["feat/work"], remote: ["origin/main"] }));
    const items = await search(source, "main");
    expect(items.some((it) => it.id.startsWith("create:"))).toBe(false);
  });
});

describe("createBranchPickerSource — accept routing", () => {
  it("local item routes to checkout(workspaceId, ref)", async () => {
    const { source, checkout, checkoutTracking, createBranch } = buildSource(
      fixture({ local: ["feat/work", "main"], remote: [] }),
    );
    const items = await search(source, "");
    const local = items.find((it) => it.id === "local:main");
    if (!local) throw new Error("expected local item");
    source.accept(local, { mode: "default" });
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout.mock.calls[0]).toEqual(["ws-1", "main"]);
    expect(checkoutTracking).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("remote-only item routes to checkoutTracking(workspaceId, fullRemoteRef)", async () => {
    const { source, checkout, checkoutTracking, createBranch } = buildSource(
      fixture({ local: ["feat/work"], remote: ["origin/main"] }),
    );
    const items = await search(source, "");
    const remote = items.find((it) => it.id === "remote:origin/main");
    if (!remote) throw new Error("expected remote item");
    source.accept(remote, { mode: "default" });
    expect(checkoutTracking).toHaveBeenCalledTimes(1);
    expect(checkoutTracking.mock.calls[0]).toEqual(["ws-1", "origin/main"]);
    expect(checkout).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("create-branch item routes to createBranch(workspaceId, name, true)", async () => {
    const { source, checkout, checkoutTracking, createBranch } = buildSource(
      fixture({ local: ["feat/work"], remote: [] }),
    );
    const items = await search(source, "scratch");
    const createRow = items.find((it) => it.id === "create:scratch");
    if (!createRow) throw new Error("expected create row");
    source.accept(createRow, { mode: "default" });
    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch.mock.calls[0]).toEqual(["ws-1", "scratch", true]);
    expect(checkout).not.toHaveBeenCalled();
    expect(checkoutTracking).not.toHaveBeenCalled();
  });

  it("routes Cmd/Ctrl branch shortcuts to delete, rename, and upstream callbacks", async () => {
    const { source, requestDelete, requestRename, requestSetUpstream, checkout } = buildSource(
      fixture({ local: ["feat/work", "main"], remote: [] }),
    );
    const items = await search(source, "");
    const local = items.find((it) => it.id === "local:main");
    if (!local) throw new Error("expected local item");

    source.accept(local, { mode: "default", key: "Backspace", modifiers: metaModifiers() });
    source.accept(local, { mode: "default", key: "r", modifiers: metaModifiers() });
    source.accept(local, { mode: "default", key: "u", modifiers: ctrlModifiers() });

    expect(requestDelete).toHaveBeenCalledWith(local);
    expect(requestRename).toHaveBeenCalledWith(local);
    expect(requestSetUpstream).toHaveBeenCalledWith(local);
    expect(checkout).not.toHaveBeenCalled();
  });

  it("can retarget a ref without checkout or create side effects", async () => {
    const list = fixture({ local: ["feat/work", "main"], remote: ["origin/release"] });
    const acceptRef = mock(() => {});
    const checkout = mock(async () => {});
    const checkoutTracking = mock(async () => {});
    const createBranch = mock(async () => {});
    const source = createBranchPickerSource({
      workspaceId: "ws-1",
      listBranches: async () => list,
      checkout,
      checkoutTracking,
      createBranch,
      allowCreate: false,
      acceptRef,
      title: "View history of",
    });

    const typedItems = await search(source, "scratch");
    expect(typedItems.some((it) => it.id.startsWith("create:"))).toBe(false);

    const items = await search(source, "release");
    const remote = items.find((it) => it.id === "remote:origin/release");
    if (!remote) throw new Error("expected remote ref item");

    source.accept(remote, { mode: "default" });

    expect(acceptRef).toHaveBeenCalledWith("origin/release", remote);
    expect(checkout).not.toHaveBeenCalled();
    expect(checkoutTracking).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
  });
});

/** Returns modifier payload for Cmd shortcuts. */
function metaModifiers() {
  return { meta: true, ctrl: false, alt: false, shift: false };
}

/** Returns modifier payload for Ctrl shortcuts. */
function ctrlModifiers() {
  return { meta: false, ctrl: true, alt: false, shift: false };
}
