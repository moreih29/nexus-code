/**
 * The renderer's way to a workspace's notes (the notes IPC channel), and the
 * URLs the editor shows a note's pictures by.
 */
import type { DocNode } from "../../../shared/notes/markdown";
import type { TranscriptFile } from "../../../shared/notes/transcript";
import type { NoteAsset, NoteContent, NoteSummary } from "../../../shared/notes/types";
import type { NoteChanged } from "../../../shared/types/notes";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";

const call = async <T>(p: Promise<import("../../ipc/client").IpcResult<T>>): Promise<T> =>
  unwrapIpcResult(await p);

export const notesApi = {
  list: (workspaceId: string): Promise<NoteSummary[]> =>
    call(ipcCallResult("notes", "list", { workspaceId })),
  create: (workspaceId: string, title?: string): Promise<NoteContent> =>
    call(
      ipcCallResult("notes", "create", { workspaceId, ...(title ? { title } : {}) }),
    ) as Promise<NoteContent>,
  read: (workspaceId: string, noteId: string): Promise<NoteContent> =>
    call(ipcCallResult("notes", "read", { workspaceId, noteId })) as Promise<NoteContent>,
  save: (
    workspaceId: string,
    noteId: string,
    change: { title?: string; doc?: DocNode },
  ): Promise<NoteSummary> =>
    call(
      ipcCallResult("notes", "save", {
        workspaceId,
        noteId,
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.doc !== undefined ? { doc: change.doc as { type: "doc" } } : {}),
      }),
    ),
  prune: (workspaceId: string, noteId: string): Promise<string[]> =>
    call(ipcCallResult("notes", "prune", { workspaceId, noteId })),
  remove: (workspaceId: string, noteId: string): Promise<void> =>
    call(ipcCallResult("notes", "remove", { workspaceId, noteId })),
  addFiles: (workspaceId: string, noteId: string, paths: string[]): Promise<NoteAsset[]> =>
    call(ipcCallResult("notes", "addFiles", { workspaceId, noteId, paths })),
  addImage: async (
    workspaceId: string,
    noteId: string,
    file: Blob,
    name?: string,
  ): Promise<NoteAsset> => {
    const ext = imageExt(file.type);
    if (!ext) throw new Error(`not an image: ${file.type}`);
    const base64 = await blobToBase64(file);
    return call(
      ipcCallResult("notes", "addImage", {
        workspaceId,
        noteId,
        base64,
        ext,
        ...(name ? { name } : {}),
      }),
    );
  },
  saveSketch: (
    workspaceId: string,
    noteId: string,
    sketch: { id?: string; scene: string; svg: string },
  ): Promise<{ id: string; src: string; scene: string }> =>
    call(
      ipcCallResult("notes", "saveSketch", {
        workspaceId,
        noteId,
        ...(sketch.id ? { sketchId: sketch.id } : {}),
        scene: sketch.scene,
        svg: sketch.svg,
      }),
    ),
  readAsset: (
    workspaceId: string,
    noteId: string,
    src: string,
  ): Promise<{ base64: string; mime: string }> =>
    call(ipcCallResult("notes", "readAsset", { workspaceId, noteId, src })),
  openAsset: (workspaceId: string, noteId: string, src: string): Promise<void> =>
    call(ipcCallResult("notes", "openAsset", { workspaceId, noteId, src })),
  revealAsset: (workspaceId: string, noteId: string, src: string): Promise<void> =>
    call(ipcCallResult("notes", "revealAsset", { workspaceId, noteId, src })),
  revealNote: (workspaceId: string, noteId: string): Promise<void> =>
    call(ipcCallResult("notes", "revealNote", { workspaceId, noteId })),
  pickFiles: (images = false): Promise<string[]> =>
    call(ipcCallResult("notes", "pickFiles", { images })),
  readTranscript: (workspaceId: string, noteId: string): Promise<TranscriptFile> =>
    call(ipcCallResult("notes", "readTranscript", { workspaceId, noteId })),
  saveTranscript: (
    workspaceId: string,
    noteId: string,
    transcript: TranscriptFile,
    announce = false,
  ): Promise<void> =>
    call(ipcCallResult("notes", "saveTranscript", { workspaceId, noteId, transcript, announce })),
  appendAudio: (workspaceId: string, noteId: string, file: string, audio: Uint8Array) =>
    call(ipcCallResult("notes", "appendAudio", { workspaceId, noteId, file, audio })),
  removeRecording: (
    workspaceId: string,
    noteId: string,
    recordingId: string,
    text = false,
  ): Promise<TranscriptFile> =>
    call(ipcCallResult("notes", "removeRecording", { workspaceId, noteId, recordingId, text })),
  onChanged: (cb: (event: NoteChanged) => void): (() => void) => ipcListen("notes", "changed", cb),
};

export function imageExt(mime: string): "png" | "jpg" | "gif" | "webp" | null {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return null;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Object URLs of a note's files, made once per (note, file, version) and
 * let go of when the note's editor closes.
 */
export class NoteAssetUrls {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(
    private readonly workspaceId: string,
    private readonly noteId: string,
  ) {}

  get(src: string, version = 0): Promise<string> {
    const key = `${src}#${version}`;
    let url = this.urls.get(key);
    if (!url) {
      url = notesApi
        .readAsset(this.workspaceId, this.noteId, src)
        .then(({ base64, mime }) => URL.createObjectURL(base64ToBlob(base64, mime)));
      url.catch(() => this.urls.delete(key));
      this.urls.set(key, url);
    }
    return url;
  }

  async text(src: string): Promise<string | null> {
    try {
      const { base64 } = await notesApi.readAsset(this.workspaceId, this.noteId, src);
      return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const url of this.urls.values()) void url.then(URL.revokeObjectURL, () => {});
    this.urls.clear();
  }
}
