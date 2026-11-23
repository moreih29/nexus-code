import { copyText } from "@/utils/clipboard";
import { relPath } from "@/utils/path";
import { toNativeDrivePath } from "../../../shared/fs/drive-path";
import { revealInFinder as revealInFinderService } from "./reveal";

export interface PathActionContext {
  workspaceId: string;
  workspaceRootPath: string;
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
      copyText(toNativeDrivePath(abs));
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
