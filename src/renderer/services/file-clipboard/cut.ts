/** Mark entries for cut (move) in the file clipboard. */

import { useFileClipboardStore } from "./store";
import type { FileClipboardInput } from "./copy";

export function handleCut(input: FileClipboardInput): void {
  useFileClipboardStore.getState().set("cut", input.workspaceId, input.entries, input.workspaceRootPath);
}