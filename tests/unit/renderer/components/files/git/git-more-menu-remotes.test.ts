/**
 * Scenario tests for GitMoreMenu shell and remote-management rules.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  buildAutofetchMenuModel,
  buildGitBranchMenuModel,
  buildGitMoreMenuLayoutModel,
  buildGitRemotesMenuModel,
  buildGitStashMenuModel,
  buildGitTagMenuModel,
  buildRemoteUpstreamWarning,
  formatLastFetchedCaption,
  resolveGitDeleteRemoteTagAction,
  resolveGitPushTagsAction,
  runGitBranchMenuAction,
  runGitTagMenuAction,
} from "../../../../../../src/renderer/components/files/git/utils/git-more-menu-model";
import { validateGitRemoteUrl } from "../../../../../../src/shared/git-remote-validation";
import type { BranchInfo } from "../../../../../../src/shared/types/git";

const branch: BranchInfo = {
  current: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  isUnborn: false,
};

describe("GitMoreMenu top-level shell", () => {
  it("matches the decided More menu order and removes top-level cherry-pick", () => {
    const labels = buildGitMoreMenuLayoutModel().map((item) =>
      item.kind === "separator" ? "—" : item.label,
    );

    expect(labels).toEqual([
      "Refresh",
      "—",
      "Fetch",
      "Pull",
      "Push",
      "—",
      "Checkout to…",
      "Branch",
      "Remote",
      "Stash",
      "Tag",
      "—",
      "Autofetch",
      "—",
      "Discard All Changes",
    ]);
    expect(labels).not.toContain("Cherry-pick Commit…");
    expect(labels).not.toContain("Tags…");
    expect(labels).not.toContain("Remotes");
  });

  it("keeps init in the first group and marks Discard All Changes destructive", () => {
    const model = buildGitMoreMenuLayoutModel(true);
    const labels = model.map((item) => (item.kind === "separator" ? "—" : item.label));

    expect(labels.slice(0, 3)).toEqual(["Refresh", "Initialize Repository", "—"]);
    expect(model.at(-1)).toEqual({
      kind: "item",
      label: "Discard All Changes",
      destructive: true,
    });
  });
});

describe("GitMoreMenu Branch/Stash/Tag submenu shells", () => {
  it("wires branch workflow/create/management entries", () => {
    const model = buildGitBranchMenuModel({ hasHead: true });

    expect(labels(model)).toEqual([
      "Merge Branch…",
      "Rebase Current Branch…",
      "—",
      "Create New Branch…",
      "Create New Branch From…",
      "—",
      "Rename Branch…",
      "Delete Branch…",
      "Delete Remote Branch…",
    ]);
    expect(disabledLabels(model)).toEqual([]);
  });

  it("dispatches Branch submenu management entries to the picker mode callbacks", () => {
    const handlers = {
      onMergeBranch: mock(() => {}),
      onRebaseBranch: mock(() => {}),
      onCreateBranch: mock(() => {}),
      onCreateBranchFrom: mock(() => {}),
      onRenameBranch: mock(() => {}),
      onDeleteBranch: mock(() => {}),
      onDeleteRemoteBranch: mock(() => {}),
    };

    runGitBranchMenuAction("rename", handlers);
    runGitBranchMenuAction("delete", handlers);
    runGitBranchMenuAction("delete-remote", handlers);

    expect(handlers.onRenameBranch).toHaveBeenCalledTimes(1);
    expect(handlers.onDeleteBranch).toHaveBeenCalledTimes(1);
    expect(handlers.onDeleteRemoteBranch).toHaveBeenCalledTimes(1);
    expect(handlers.onMergeBranch).not.toHaveBeenCalled();
  });

  it("moves the three existing stash actions into the Stash submenu with existing gates", () => {
    const model = buildGitStashMenuModel({ hasHead: true, stashCount: 1 });

    expect(labels(model)).toEqual(["Stash", "Stash Pop", "Stashes…", "—", "Drop Stash…"]);
    expect(disabledLabels(model)).toEqual([]);

    const empty = buildGitStashMenuModel({ hasHead: true, stashCount: 0 });
    expect(disabledLabels(empty)).toEqual(["Stash Pop", "Drop Stash…"]);
  });

  it("includes Drop Stash… entry in Stash submenu with correct gating", () => {
    // Enabled when stash has entries and HEAD exists.
    const withStash = buildGitStashMenuModel({ hasHead: true, stashCount: 2 });
    const dropItem = withStash.find((item) => item.kind === "item" && item.id === "drop-stash");
    expect(dropItem).toMatchObject({
      kind: "item",
      id: "drop-stash",
      label: "Drop Stash…",
      disabled: false,
    });

    // Disabled with "Stash is empty." when stash count is 0.
    const noStash = buildGitStashMenuModel({ hasHead: true, stashCount: 0 });
    const dropNoStash = noStash.find((item) => item.kind === "item" && item.id === "drop-stash");
    expect(dropNoStash).toMatchObject({ disabled: true, title: "Stash is empty." });

    // Disabled with "Make an initial commit first." when no HEAD.
    const noHead = buildGitStashMenuModel({ hasHead: false, stashCount: 0 });
    const dropNoHead = noHead.find((item) => item.kind === "item" && item.id === "drop-stash");
    expect(dropNoHead).toMatchObject({ disabled: true, title: "Stash is empty." });

    // Disabled when repo is busy (disabled flag).
    const busy = buildGitStashMenuModel({ disabled: true, hasHead: true, stashCount: 1 });
    const dropBusy = busy.find((item) => item.kind === "item" && item.id === "drop-stash");
    expect(dropBusy).toMatchObject({ disabled: true });
  });

  it("Drop Stash… entry is separated from read-only stash entries by a separator", () => {
    const model = buildGitStashMenuModel({ hasHead: true, stashCount: 1 });
    const dropIndex = model.findIndex((item) => item.kind === "item" && item.id === "drop-stash");
    const itemBeforeDrop = model[dropIndex - 1];
    expect(itemBeforeDrop?.kind).toBe("separator");
  });

  it("exposes the wired Tag submenu entries and keeps Push Tags enablement from remotes", () => {
    const model = buildGitTagMenuModel({ hasHead: true, remotes: [] });

    expect(labels(model)).toEqual([
      "Create Tag…",
      "Delete Tag…",
      "Delete Remote Tag…",
      "—",
      "Push Tags",
    ]);
    expect(disabledLabels(model)).toEqual(["Delete Remote Tag…", "Push Tags"]);
    expect(model.filter((item) => item.kind === "item" && item.placeholder === true)).toHaveLength(
      0,
    );
    expect(model.filter((item) => item.kind === "item").map((item) => item.title)).not.toContain(
      "Coming soon.",
    );
    expect(model.find((item) => item.kind === "item" && item.id === "push-tags")).toMatchObject({
      disabled: true,
      title: "No remotes configured",
    });

    const withRemote = buildGitTagMenuModel({ hasHead: true, remotes: ["origin"] });
    expect(disabledLabels(withRemote)).toEqual([]);
    expect(
      withRemote.find((item) => item.kind === "item" && item.id === "push-tags"),
    ).toMatchObject({
      disabled: false,
      title: undefined,
    });
  });

  it("dispatches Tag submenu picker entries to their TagPicker modes", () => {
    const handlers = {
      onOpenTags: mock(() => {}),
    };

    runGitTagMenuAction("create", handlers);
    runGitTagMenuAction("delete", handlers);
    runGitTagMenuAction("delete-remote", handlers, "origin");

    expect(handlers.onOpenTags).toHaveBeenCalledTimes(3);
    expect(handlers.onOpenTags).toHaveBeenNthCalledWith(1, "create");
    expect(handlers.onOpenTags).toHaveBeenNthCalledWith(2, "delete-local");
    expect(handlers.onOpenTags).toHaveBeenNthCalledWith(3, "delete-remote", "origin");
  });
});

describe("GitMoreMenu Delete Remote Tag remote branching", () => {
  it("disables Delete Remote Tag with the no-remote reason when no remotes are configured", () => {
    expect(resolveGitDeleteRemoteTagAction({ hasHead: true, remotes: [] })).toEqual({
      kind: "disabled",
      reason: "No remotes configured",
    });
  });

  it("opens directly for one remote and opens a chooser for multiple remotes", () => {
    expect(resolveGitDeleteRemoteTagAction({ hasHead: true, remotes: ["origin"] })).toEqual({
      kind: "open-picker",
      remote: "origin",
    });
    expect(
      resolveGitDeleteRemoteTagAction({ hasHead: true, remotes: ["origin", "upstream"] }),
    ).toEqual({
      kind: "choose-remote",
      remotes: ["origin", "upstream"],
    });
  });
});

describe("GitMoreMenu Push Tags remote branching", () => {
  it("disables Push Tags with the no-remote reason when no remotes are configured", () => {
    expect(resolveGitPushTagsAction({ hasHead: true, remotes: [] })).toEqual({
      kind: "disabled",
      reason: "No remotes configured",
    });
  });

  it("pushes immediately for one remote and opens a chooser for multiple remotes", () => {
    expect(resolveGitPushTagsAction({ hasHead: true, remotes: ["origin"] })).toEqual({
      kind: "push",
      remote: "origin",
    });
    expect(resolveGitPushTagsAction({ hasHead: true, remotes: ["origin", "upstream"] })).toEqual({
      kind: "choose-remote",
      remotes: ["origin", "upstream"],
    });
  });
});

describe("GitMoreMenu Remotes submenu model", () => {
  it("lists current remotes in order and keeps add/remove actions discoverable", () => {
    const model = buildGitRemotesMenuModel(["origin", "upstream"]);

    expect(model.map((item) => item.label)).toEqual([
      "origin",
      "upstream",
      "Add remote…",
      "Remove remote…",
    ]);
    expect(model.filter((item) => item.kind === "remote").map((item) => item.label)).toEqual([
      "origin",
      "upstream",
    ]);
  });

  it("disables remove when no remotes are configured", () => {
    const model = buildGitRemotesMenuModel([]);
    const remove = model.find((item) => item.kind === "action" && item.id === "remove-remote");

    expect(model[0]).toEqual({ kind: "empty", label: "No remotes configured" });
    expect(remove).toMatchObject({ disabled: true });
  });
});

/** Collects user-visible labels from shell model entries. */
function labels(model: ReadonlyArray<{ kind: string; label?: string }>): string[] {
  return model.map((item) => (item.kind === "separator" ? "—" : (item.label ?? "")));
}

/** Collects disabled labels from shell model entries. */
function disabledLabels(
  model: ReadonlyArray<{ kind: string; label?: string; disabled?: boolean }>,
): string[] {
  return model
    .filter((item) => item.kind === "item" && item.disabled === true)
    .map((item) => item.label ?? "");
}

describe("GitMoreMenu Autofetch submenu model", () => {
  it("offers exactly Off and Every 3 min with the selected interval checked", () => {
    expect(buildAutofetchMenuModel(3)).toEqual([
      { intervalMin: 0, label: "Off", selected: false },
      { intervalMin: 3, label: "Every 3 min", selected: true },
    ]);
    expect(buildAutofetchMenuModel(0)).toEqual([
      { intervalMin: 0, label: "Off", selected: true },
      { intervalMin: 3, label: "Every 3 min", selected: false },
    ]);
  });

  it("formats the last-fetched caption from FETCH_HEAD mtime", () => {
    expect(formatLastFetchedCaption(null, 1_000)).toBe("Last fetched never");
    expect(formatLastFetchedCaption(1_000, 1_500)).toBe("Last fetched just now");
    expect(formatLastFetchedCaption(1_000, 121_000)).toBe("Last fetched 2m ago");
  });
});

describe("remote add/remove validation copy", () => {
  it("accepts only the supported URL patterns without probing the network", () => {
    expect(validateGitRemoteUrl("https://github.com/org/repo.git")).toBeNull();
    expect(validateGitRemoteUrl("git@github.com:org/repo.git")).toBeNull();
    expect(validateGitRemoteUrl("ssh://git@example.invalid/repo.git")).toBeNull();
    expect(validateGitRemoteUrl("file:///tmp/repo.git")).toBeNull();
    expect(validateGitRemoteUrl("github.com/org/repo")).toBe(
      "Use https://, git@, ssh://, or file://.",
    );
  });

  it("shows the upstream-detach warning only for the tracked remote", () => {
    expect(buildRemoteUpstreamWarning(branch, "origin")).toBe(
      "main tracks origin/... Removing detaches upstream tracking.",
    );
    expect(buildRemoteUpstreamWarning(branch, "upstream")).toBeNull();
  });
});
