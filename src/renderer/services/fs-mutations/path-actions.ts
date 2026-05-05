/**
 * Build the "Reveal in Finder / Copy Path / Copy Relative Path" trio
 * from a single resolver. Both the file-tree right-click menu and the
 * tab-strip right-click menu need exactly these three actions, just
 * with different sources (a file-tree row vs. an editor tab).
 *
 * The factory exists so the two menus stay in lockstep — adding a new
 * action (e.g. "Open Containing Folder") here means it lights up in
 * both menus without each one rolling its own copy.
 *
 * Pure factory. No React, no hooks; just closures over the resolver.
 * Callers attach the returned handlers to their menu spec items.
 */

import { copyText } from "@/utils/clipboard";
import { relPath } from "@/utils/path";
import { revealInFinder as revealInFinderService } from "./reveal";

export interface PathActionContext {
  workspaceId: string;
  workspaceRootPath: string;
  /**
   * Resolve the absolute path of the action's target. Returns null
   * when there's nothing to act on (e.g. the menu is anchored to a
   * non-editor tab) — handlers no-op in that case.
   */
  getAbsPath: () => string | null;
}

export interface PathActions {
  copyPath: () => void;
  copyRelativePath: () => void;
  revealInFinder: () => void;
}

export function createPathActions(ctx: PathActionContext): PathActions {
  return {
    copyPath() {
      const abs = ctx.getAbsPath();
      if (!abs) return;
      copyText(abs);
    },
    copyRelativePath() {
      const abs = ctx.getAbsPath();
      if (!abs) return;
      copyText(relPath(abs, ctx.workspaceRootPath));
    },
    revealInFinder() {
      const abs = ctx.getAbsPath();
      if (!abs) return;
      void revealInFinderService({
        workspaceId: ctx.workspaceId,
        workspaceRootPath: ctx.workspaceRootPath,
        absPath: abs,
      });
    },
  };
}
