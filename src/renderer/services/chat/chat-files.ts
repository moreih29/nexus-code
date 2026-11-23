import { createContext, useContext } from "react";
import type { ChatMediaAccess, ImageBlock } from "./model";
import { useRemotePicture } from "./remote-picture";

export interface ChatFiles {
  access: ChatMediaAccess | null;
  epoch: number | null;
  connection: number | null;
  there(paths: readonly string[]): Promise<ReadonlySet<string>>;
  gone?(paths: readonly string[]): Promise<ReadonlySet<string>>;
  picture(path: string): Promise<ImageBlock>;
  subscribePicture(path: string, listener: (image: ImageBlock | null) => void): () => void;
}

export const ChatFilesContext = createContext<ChatFiles | null>(null);

export function useChatFiles(): ChatFiles | null {
  return useContext(ChatFilesContext);
}

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
