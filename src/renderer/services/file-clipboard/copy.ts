import { copyText } from "@/utils/clipboard";
import { toNativeDrivePath } from "../../../shared/fs/drive-path";
import { useFileClipboardStore } from "./store";

export type { ClipboardEntry } from "./store";

export interface FileClipboardInput {
  workspaceId: string;
  workspaceRootPath: string;
  entries: Array<{ relPath: string; absPath: string }>;
}

export function handleCopy(input: FileClipboardInput): void {
  copyText(input.entries.map((e) => toNativeDrivePath(e.absPath)).join("\n"));

  useFileClipboardStore
    .getState()
    .set("copy", input.workspaceId, input.entries, input.workspaceRootPath);
}
