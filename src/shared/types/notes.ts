/** The notes channel's arguments and results (see shared/notes/types.ts). */
import { z } from "zod";
import { RECORDING_ID_RE, TAKE_FILE_RE, TranscriptFileSchema } from "../notes/transcript";
import { NOTE_ID_RE, SKETCH_ID_RE } from "../notes/types";
import { WorkspaceIdSchema } from "./workspace-id";

export const NoteIdSchema = z.string().regex(NOTE_ID_RE);

/** A document as TipTap's getJSON() gives it; checked for its shape only at the top. */
export const NoteDocSchema = z.object({ type: z.literal("doc") }).passthrough();

/** Most bytes of a pasted image, before base64. */
export const MAX_NOTE_IMAGE_BYTES = 30 * 1024 * 1024;

/** Most bytes of one piece of a recording's audio, as it is written while recording. */
export const MAX_RECORDING_CHUNK_BYTES = 8 * 1024 * 1024;

/** Most characters of a sketch's scene JSON (it holds its images). */
export const MAX_SKETCH_SCENE_CHARS = 60 * 1024 * 1024;

const NoteCountsSchema = z.object({
  sketches: z.number(),
  files: z.number(),
  images: z.number(),
  todos: z.number(),
  todosDone: z.number(),
});

export const NoteSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  counts: NoteCountsSchema,
  excerpt: z.string(),
  recording: z.object({ recordings: z.number(), ms: z.number(), people: z.number() }).optional(),
});

export const NoteContentSchema = NoteSummarySchema.extend({
  doc: NoteDocSchema,
  dir: z.string(),
});

export const NoteAssetSchema = z.object({ src: z.string(), name: z.string(), size: z.number() });

export const NoteLocationSchema = z.object({
  key: z.string(),
  kind: z.enum(["local", "ssh", "wsl"]),
  path: z.string(),
  host: z.string().optional(),
  label: z.string(),
});

export const NoteStorageEntrySchema = z.object({
  location: NoteLocationSchema,
  notes: z.number(),
  bytes: z.object({
    text: z.number(),
    sketches: z.number(),
    files: z.number(),
    images: z.number(),
    recordings: z.number(),
  }),
  updatedAt: z.number(),
  /** The workspaces open in the app whose folder this is. */
  workspaceIds: z.array(z.string()),
});

const ws = { workspaceId: WorkspaceIdSchema };
const note = { ...ws, noteId: NoteIdSchema };
const asset = { ...note, src: z.string().min(1).max(1024) };

export const NotesArgs = {
  list: z.object(ws),
  create: z.object({ ...ws, title: z.string().max(500).optional() }),
  read: z.object(note),
  save: z.object({ ...note, title: z.string().max(500).optional(), doc: NoteDocSchema.optional() }),
  remove: z.object(note),
  prune: z.object(note),
  addFiles: z.object({ ...note, paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }),
  addImage: z.object({
    ...note,
    base64: z.string().max(Math.ceil(MAX_NOTE_IMAGE_BYTES / 3) * 4),
    ext: z.enum(["png", "jpg", "jpeg", "gif", "webp"]),
    name: z.string().max(255).optional(),
  }),
  saveSketch: z.object({
    ...note,
    sketchId: z.string().regex(SKETCH_ID_RE).optional(),
    scene: z.string().max(MAX_SKETCH_SCENE_CHARS),
    svg: z.string().max(MAX_SKETCH_SCENE_CHARS),
  }),
  readAsset: z.object(asset),
  openAsset: z.object(asset),
  revealAsset: z.object(asset),
  revealNote: z.object(note),
  pickFiles: z.object({ images: z.boolean().optional() }),
  storage: z.void(),
  readTranscript: z.object(note),
  saveTranscript: z.object({
    ...note,
    transcript: TranscriptFileSchema,
    /** Tells the windows the note changed (a recording ended): its row recounts. */
    announce: z.boolean().optional(),
  }),
  /** Adds to the end of a take's audio file (made by the first piece). */
  appendAudio: z.object({
    ...note,
    file: z.string().regex(TAKE_FILE_RE),
    audio: z.custom<Uint8Array>(
      (v) => v instanceof Uint8Array && v.byteLength <= MAX_RECORDING_CHUNK_BYTES,
      "audio bytes",
    ),
  }),
  /** Moves a recording's audio to the Trash; with `text`, its words go from the transcript too. */
  removeRecording: z.object({
    ...note,
    recordingId: z.string().regex(RECORDING_ID_RE),
    text: z.boolean().optional(),
  }),
  /**
   * What the window's recorder does, as it changes: the note it records
   * into and how long it has recorded, or `null` when it stopped. Other
   * devices see it in the sessions' list (a phone puts photos into it).
   */
  recording: z.object({
    now: z
      .object({
        ...note,
        recordedMs: z.number().nonnegative(),
        paused: z.boolean(),
      })
      .nullable(),
  }),
  removeLocation: z.object({ key: z.string().min(1).max(8192) }),
  revealLocation: z.object({ key: z.string().min(1).max(8192) }),
};

export const NoteChangedSchema = z.object({
  /** The location's key whose notes changed. */
  locationKey: z.string(),
  /** The note that changed, if it was one; missing when a whole location went. */
  noteId: z.string().optional(),
  /** What happened to it. */
  change: z.enum(["created", "saved", "removed"]),
});
export type NoteChanged = z.infer<typeof NoteChangedSchema>;

/** A photo another device put into a note (notes.attach), for the windows that have it open. */
export const NotePhotoAddedSchema = z.object({
  locationKey: z.string(),
  noteId: z.string(),
  /** Where the note keeps it: "screens/…". */
  src: z.string(),
  name: z.string(),
});
export type NotePhotoAdded = z.infer<typeof NotePhotoAddedSchema>;
