/**
 * Scenario tests for GitMoreMenu remote-management rules.
 */
import { describe, expect, it } from "bun:test";
import {
  buildAutofetchMenuModel,
  buildGitRemotesMenuModel,
  buildRemoteUpstreamWarning,
  formatLastFetchedCaption,
} from "../../../../../../src/renderer/components/files/git/GitMoreMenu";
import { validateGitRemoteUrl } from "../../../../../../src/shared/git-remote-validation";
import type { BranchInfo } from "../../../../../../src/shared/types/git";

const branch: BranchInfo = {
  current: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  isUnborn: false,
};

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

describe("GitMoreMenu Autofetch submenu model", () => {
  it("offers Off and the accepted interval choices with 3 minutes marked as default", () => {
    const labels = buildAutofetchMenuModel(3).map((item) =>
      item.selected ? `selected:${item.label}` : item.label,
    );

    expect(labels).toEqual([
      "Off",
      "Every 1 min",
      "selected:Every 3 min (default)",
      "Every 5 min",
      "Every 15 min",
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
