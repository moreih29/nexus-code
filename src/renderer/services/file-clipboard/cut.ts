/** Mark entries for cut (move) in the file clipboard. */

import type { FileClipboardInput } from "./copy";
import { useFileClipboardStore } from "./store";

export function handleCut(input: FileClipboardInput): void {
  useFileClipboardStore
    .getState()
    .set("cut", input.workspaceId, input.entries, input.workspaceRootPath);
}
