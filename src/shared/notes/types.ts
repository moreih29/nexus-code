/**
 * Notes: a workspace's notes, kept by the app in its data folder (not in the
 * workspace), one folder per note. A workspace's notes are found by where
 * its folder is (the location), not by the workspace's id, so they outlive
 * the workspace being removed and come back when it is added again.
 */
import type { DocNode } from "./markdown";

/** Where a workspace's folder is: the key its notes are kept under. */
export interface NoteLocation {
  /** "local:/Users/me/ws", "ssh:me@host:22:/srv/ws", "wsl:Ubuntu:/home/me/ws". */
  key: string;
  kind: "local" | "ssh" | "wsl";
  /** The folder, as the workspace has it. */
  path: string;
  /** ssh: user@host[:port]; wsl: the distribution. */
  host?: string;
  /** The workspace's name when the notes were last written. */
  label: string;
}

/** What `note.json` holds. */
export interface NoteFile {
  version: 1;
  id: string;
  title: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** The editor's document (ProseMirror JSON). */
  doc: DocNode;
}

/** What a note has in it, for its row in the list. */
export interface NoteCounts {
  sketches: number;
  files: number;
  images: number;
  todos: number;
  todosDone: number;
}

/** What a note's recordings add up to (transcript.json), when it has any. */
export interface NoteRecordingSummary {
  recordings: number;
  /** Their length together. */
  ms: number;
  /** The most people heard in one of them (voices given one name count once). */
  people: number;
}

/** A note's row in the notes list. */
export interface NoteSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  counts: NoteCounts;
  /** The first words of its text. */
  excerpt: string;
  recording?: NoteRecordingSummary;
}

/** A note as the editor opens it. */
export interface NoteContent extends NoteSummary {
  doc: DocNode;
  /** The note's folder on this machine. */
  dir: string;
}

/** A file put into a note's folder. */
export interface NoteAsset {
  /** Relative to the note's folder: "materials/x.pdf", "screens/…png", "sketches/…svg". */
  src: string;
  name: string;
  size: number;
}

/** One location's notes, on the storage page. */
export interface NoteStorageEntry {
  location: NoteLocation;
  notes: number;
  /** Bytes by what they are. */
  bytes: { text: number; sketches: number; files: number; images: number; recordings: number };
  /** Its newest note's updatedAt (0 for none). */
  updatedAt: number;
}

/** A note's folder's parts. */
export const NOTE_DIRS = {
  sketches: "sketches",
  files: "materials",
  images: "screens",
  recordings: "recordings",
} as const;

/** A note's id: "n" and base-36 time and randomness. */
export const NOTE_ID_RE = /^n[0-9a-z]{6,24}$/;

/** A sketch's id within its note. */
export const SKETCH_ID_RE = /^s[0-9a-z]{4,24}$/;

/** The block an image put into a note takes, as the editor makes it. */
export function imageBlock(asset: { src: string; name: string }): DocNode {
  return { type: "noteImage", attrs: { src: asset.src, alt: asset.name } };
}

/** Whether the document shows the image at `src` somewhere. */
export function hasImage(doc: DocNode, src: string): boolean {
  if (doc.type === "noteImage" && doc.attrs?.src === src) return true;
  return (doc.content ?? []).some((c) => hasImage(c, src));
}
