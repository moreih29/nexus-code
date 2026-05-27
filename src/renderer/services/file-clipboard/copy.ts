/** Copy entries into the file clipboard (for later paste) + system clipboard. */

import { copyText } from "@/utils/clipboard";
import { useFileClipboardStore } from "./store";

export { type ClipboardEntry } from "./store";

export interface FileClipboardInput {
  workspaceId: string;
  workspaceRootPath: string;
  entries: Array<{ relPath: string; absPath: string }>;
}

export function handleCopy(input: FileClipboardInput): void {
  // Write entry paths to system clipboard (one per line).
  copyText(input.entries.map((e) => e.absPath).join("\n"));

  useFileClipboardStore.getState().set("copy", input.workspaceId, input.entries, input.workspaceRootPath);
}