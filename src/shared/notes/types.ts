import type { DocNode } from "./markdown";

export interface NoteLocation {
  key: string;
  kind: "local" | "ssh" | "wsl";
  path: string;
  host?: string;
  label: string;
}

export interface NoteFile {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  doc: DocNode;
}

export interface NoteSaveChange {
  title?: string;
  doc?: DocNode;
  baseUpdatedAt?: number;
}

export interface NoteCounts {
  sketches: number;
  files: number;
  images: number;
  todos: number;
  todosDone: number;
}

export interface NoteRecordingSummary {
  recordings: number;
  ms: number;
  people: number;
}

export interface NoteSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  counts: NoteCounts;
  excerpt: string;
  recording?: NoteRecordingSummary;
}

export interface NoteContent extends NoteSummary {
  doc: DocNode;
  dir: string;
}

export interface NoteAsset {
  src: string;
  name: string;
  size: number;
}

export interface NoteStorageEntry {
  location: NoteLocation;
  notes: number;
  bytes: { text: number; sketches: number; files: number; images: number; recordings: number };
  updatedAt: number;
}

export function noteStorageWhere({ location }: Pick<NoteStorageEntry, "location">): string {
  return `${location.host ? `${location.host}:` : ""}${location.path}`;
}

export function noteStorageBytes({ bytes }: Pick<NoteStorageEntry, "bytes">): number {
  return bytes.text + bytes.sketches + bytes.files + bytes.images + bytes.recordings;
}

export const NOTE_DIRS = {
  sketches: "sketches",
  files: "materials",
  images: "screens",
  recordings: "recordings",
} as const;

export const NOTE_ID_RE = /^n[0-9a-z]{6,24}$/;

export const SKETCH_ID_RE = /^s[0-9a-z]{4,24}$/;

export function imageBlock(asset: { src: string; name: string }): DocNode {
  return { type: "noteImage", attrs: { src: asset.src, alt: asset.name } };
}

export function hasImage(doc: DocNode, src: string): boolean {
  if (doc.type === "noteImage" && doc.attrs?.src === src) return true;
  return (doc.content ?? []).some((c) => hasImage(c, src));
}
