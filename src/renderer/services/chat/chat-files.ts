/**
 * Where a chat's files are read from when they are not this computer's: the
 * chat of another computer finds the files its conversation names, and the
 * pictures of the image files among them, on that computer. Unset, a chat
 * reads them from its workspace here.
 */

import { createContext, useContext } from "react";
import type { ChatMediaAccess, ImageBlock } from "./model";
import { useRemotePicture } from "./remote-picture";

export interface ChatFiles {
  access: ChatMediaAccess | null;
  /** The peer connection and foreground lifetime; null while unavailable. */
  epoch: number | null;
  /** The peer connection alone, which a return to the foreground keeps; null while unavailable. */
  connection: number | null;
  /** Which of these absolute paths are files. */
  there(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** An image file's picture, small enough for a card. */
  picture(path: string): Promise<ImageBlock>;
  subscribePicture(path: string, listener: (image: ImageBlock | null) => void): () => void;
}

export const ChatFilesContext = createContext<ChatFiles | null>(null);

export function useChatFiles(): ChatFiles | null {
  return useContext(ChatFilesContext);
}

/** The currently authorized image for the path. */
export function useFilePicture(
  files: ChatFiles | null,
  path: string,
): { image: ImageBlock | null; failed: boolean } {
  return useRemotePicture(files?.access, path, (show) => {
    if (!files) return;
    const off = files.subscribePicture(path, show);
    void files.picture(path).then(show, () => show(null));
    return off;
  });
}
