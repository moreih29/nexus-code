/**
 * Pure tests for buildGroupTabBarMenuItems.
 *
 * Covers the branching shape — null context → empty, terminal context
 * hides the editor-only group (Reveal in Finder + Copy Path family),
 * pin label flips with isPinned.
 */

import { describe, expect, it } from "bun:test";
import {
  buildGroupTabBarMenuItems,
  type TabContextInfo,
} from "../../../../../../src/renderer/components/workspace/group/group-tab-bar-menu";
import type { useGroupActions } from "../../../../../../src/renderer/components/workspace/group/use-group-actions";

type Actions = ReturnType<typeof useGroupActions>;

const noopActions: Actions = {
  close: async () => {},
  closeOthers: async () => {},
  closeAllToRight: async () => {},
  closeAll: async () => {},
  closeSaved: () => {},
  splitRight: () => {},
  splitDown: () => {},
  newTerminal: () => {},
};

const noop = () => {};

function labelsOf(items: ReturnType<typeof buildGroupTabBarMenuItems>): string[] {
  return items
    .filter((it): it is Extract<typeof it, { kind: "item" }> => it.kind === "item")
    .map((it) => it.label);
}

const editorContext: TabContextInfo = { isPinned: false, isEditor: true };
const editorPinnedContext: TabContextInfo = { isPinned: true, isEditor: true };
const terminalContext: TabContextInfo = { isPinned: false, isEditor: false };

describe("buildGroupTabBarMenuItems", () => {
  it("returns an empty list when there is no context tab", () => {
    expect(
      buildGroupTabBarMenuItems({
        context: null,
        actions: noopActions,
        togglePin: noop,
        copyPath: noop,
        copyRelativePath: noop,
        revealInFinder: noop,
      }),
    ).toEqual([]);
  });

  it("editor (unpinned) menu — full close family + Split + Copy Path family", () => {
    const items = buildGroupTabBarMenuItems({
      context: editorContext,
      actions: noopActions,
      togglePin: noop,
      copyPath: noop,
      copyRelativePath: noop,
      revealInFinder: noop,
    });
    expect(labelsOf(items)).toEqual([
      "Pin Tab",
      "Close",
      "Close Others",
      "Close All to the Right",
      "Close Saved",
      "Close All",
      "Split Right",
      "Split Down",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("editor (pinned) menu — pin label flips to 'Unpin Tab'", () => {
    const items = buildGroupTabBarMenuItems({
      context: editorPinnedContext,
      actions: noopActions,
      togglePin: noop,
      copyPath: noop,
      copyRelativePath: noop,
      revealInFinder: noop,
    });
    const firstItem = items.find((it) => it.kind === "item");
    if (!firstItem || firstItem.kind !== "item") throw new Error("expected item");
    expect(firstItem.label).toBe("Unpin Tab");
  });

  it("terminal context — Copy Path family is omitted (editor-only)", () => {
    const items = buildGroupTabBarMenuItems({
      context: terminalContext,
      actions: noopActions,
      togglePin: noop,
      copyPath: noop,
      copyRelativePath: noop,
      revealInFinder: noop,
    });
    expect(labelsOf(items)).toEqual([
      "Pin Tab",
      "Close",
      "Close Others",
      "Close All to the Right",
      "Close Saved",
      "Close All",
      "Split Right",
      "Split Down",
    ]);
  });

  // Reveal-in-Finder editor/terminal branching is already covered by the
  // full label-list tests above (editor menu includes it, terminal menu
  // doesn't). Dispatch wiring is plain JS (the spec stores onSelect
  // verbatim) — not worth a dedicated test.
});
