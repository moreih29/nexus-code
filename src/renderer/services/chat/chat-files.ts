/**
 * Where a chat's files are read from when they are not this computer's: the
 * chat of another computer finds the files its conversation names, and the
 * pictures of the image files among them, on that computer. Unset, a chat
 * reads them from its workspace here.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { ImageBlock } from "./model";

export interface ChatFiles {
  /** Which of these absolute paths are files. */
  there(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** An image file's picture, small enough for a card. */
  picture(path: string): Promise<ImageBlock>;
}

export const ChatFilesContext = createContext<ChatFiles | null>(null);

export function useChatFiles(): ChatFiles | null {
  return useContext(ChatFilesContext);
}

/**
 * The picture of an image file read through `files`, once it has come;
 * nothing to do without `files`, where the workspace's URL shows it.
 */
export function useFilePicture(
  files: ChatFiles | null,
  path: string,
): { image: ImageBlock | null; failed: boolean } {
  const [state, setState] = useState<{
    path: string;
    image: ImageBlock | null;
    failed: boolean;
  }>({ path, image: null, failed: false });
  useEffect(() => {
    if (!files) return;
    let live = true;
    files.picture(path).then(
      (image) => {
        if (live) setState({ path, image, failed: false });
      },
      () => {
        if (live) setState({ path, image: null, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [files, path]);
  return state.path === path ? state : { image: null, failed: false };
}
