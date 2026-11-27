import { createContext, useCallback, useContext, useMemo } from "react";
import type {
  FileGrantPurpose,
  FileLinkSource,
  FileResolved,
} from "../../../../packages/remote-protocol/src/rpc";
import type { ChatMediaAccess, ImageBlock } from "./model";
import { useRemotePicture } from "./remote-picture";

export type { FileGrantPurpose, FileLinkSource };

export interface LinkedFile {
  href: string;
  source: FileLinkSource;
}

export type LinkFound = FileResolved;

export class LinkGrantError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

export interface ChatFiles {
  access: ChatMediaAccess | null;
  epoch: number | null;
  connection: number | null;
  there(paths: readonly string[]): Promise<ReadonlySet<string>>;
  gone?(paths: readonly string[]): Promise<ReadonlySet<string>>;
  picture(path: string): Promise<ImageBlock>;
  knownPicture?(path: string): ImageBlock | undefined;
  subscribePicture(path: string, listener: (image: ImageBlock | null) => void): () => void;
  resolve?(links: readonly LinkedFile[]): Promise<readonly LinkFound[]>;
  open?(link: LinkedFile, purpose?: FileGrantPurpose): Promise<string>;
}

export const ChatFilesContext = createContext<ChatFiles | null>(null);

export function useChatFiles(): ChatFiles | null {
  return useContext(ChatFilesContext);
}

export const FileLinkSourceContext = createContext<FileLinkSource | null>(null);

export const FileLinkRunContext = createContext<string | undefined>(undefined);

function withRun(source: FileLinkSource, runId: string | undefined): FileLinkSource {
  if (runId === undefined || source.kind === "file") return source;
  return { ...source, runId };
}

export function useLinkRun(): (link: LinkedFile) => LinkedFile {
  const runId = useContext(FileLinkRunContext);
  return useCallback(
    (link: LinkedFile) =>
      runId === undefined ? link : { href: link.href, source: withRun(link.source, runId) },
    [runId],
  );
}

export function useFileLinkSource(): FileLinkSource | null {
  const source = useContext(FileLinkSourceContext);
  const runId = useContext(FileLinkRunContext);
  return useMemo(() => (source ? withRun(source, runId) : null), [source, runId]);
}

export function useFilePicture(
  files: ChatFiles | null,
  path: string,
): { image: ImageBlock | null; failed: boolean } {
  return useRemotePicture(
    files?.access,
    path,
    (show) => {
      if (!files) return;
      const off = files.subscribePicture(path, show);
      void files.picture(path).then(show, () => show(null));
      return off;
    },
    () => files?.knownPicture?.(path),
  );
}
