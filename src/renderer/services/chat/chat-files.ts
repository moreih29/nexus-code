/**
 * Where a chat's files are read from when they are not this computer's: the
 * chat of another computer finds the files its conversation names, and the
 * pictures of the image files among them, on that computer. Unset, a chat
 * reads them from its workspace here.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { ImageBlock } from "./model";

export interface ChatFiles {
  /** The peer connection and foreground lifetime; null while unavailable. */
  epoch: number | null;
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

interface PictureState {
  files: ChatFiles | null;
  path: string;
  image: ImageBlock | null;
  failed: boolean;
}

/** The currently authorized image for the path. */
export function useFilePicture(
  files: ChatFiles | null,
  path: string,
): { image: ImageBlock | null; failed: boolean } {
  const [state, setState] = useState<PictureState>({ files, path, image: null, failed: false });
  const current = state.path === path && state.files === files;
  if (!current) setState({ files, path, image: null, failed: false });

  useEffect(() => {
    if (!files || files.epoch === null) return;
    let live = true;
    const show = (image: ImageBlock | null) => {
      if (live) setState({ files, path, image, failed: image === null });
    };
    const off = files.subscribePicture(path, show);
    void files.picture(path).catch(() => show(null));
    return () => {
      live = false;
      off();
    };
  }, [files, path]);
  if (files?.epoch === null) return { image: null, failed: true };
  return current ? state : { image: null, failed: false };
}
