/** The notes channel's arguments and results (see shared/notes/types.ts). */
import { z } from "zod";
import {
  NonnegativeNumberSchema,
  NumberSchema,
} from "../../../packages/remote-protocol/src/validation";
import {
  NewNoteLinkSchema,
  NoteConversationSchema,
  NoteLinkIdSchema,
  NoteLinkPatchSchema,
  NoteLinkResultSchema,
  NoteLinkTargetSchema,
} from "../notes/links";
import { RecordingIdSchema, RecordingSummarySchema, SummaryModeSchema } from "../notes/summary";
import { RECORDING_ID_RE, TAKE_FILE_RE, TranscriptEditSchema } from "../notes/transcript";
import { NOTE_ID_RE, SKETCH_ID_RE } from "../notes/types";
import { WorkspaceIdSchema } from "./workspace-id";

export const NoteIdSchema = z.string().regex(NOTE_ID_RE);

/** A document as TipTap's getJSON() gives it; checked for its shape only at the top. */
export const NoteDocSchema = z.looseObject({ type: z.literal("doc") });

/** Most bytes of a pasted image, before base64. */
export const MAX_NOTE_IMAGE_BYTES = 30 * 1024 * 1024;

/** Most bytes of one piece of a recording's audio, as it is written while recording. */
export const MAX_RECORDING_CHUNK_BYTES = 8 * 1024 * 1024;
/** The most audio a voice print is asked for: 10 s at 16 kHz. */
export const MAX_VOICE_PRINT_SAMPLES = 16_000 * 10;

/** Most characters of a sketch's scene JSON (it holds its images). */
export const MAX_SKETCH_SCENE_CHARS = 60 * 1024 * 1024;

const NoteCountsSchema = z.object({
  sketches: NumberSchema,
  files: NumberSchema,
  images: NumberSchema,
  todos: NumberSchema,
  todosDone: NumberSchema,
});

export const NoteSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: NumberSchema,
  updatedAt: NumberSchema,
  counts: NoteCountsSchema,
  excerpt: z.string(),
  recording: z
    .object({ recordings: NumberSchema, ms: NumberSchema, people: NumberSchema })
    .optional(),
});

export const LinkedNoteSchema = z.object({
  noteId: NoteIdSchema,
  title: z.string(),
  updatedAt: NonnegativeNumberSchema,
  line: z.string().optional(),
});
export type LinkedNote = z.infer<typeof LinkedNoteSchema>;

export const NoteContentSchema = NoteSummarySchema.extend({
  doc: NoteDocSchema,
  dir: z.string(),
});

export const NoteAssetSchema = z.object({ src: z.string(), name: z.string(), size: NumberSchema });

export const NoteLocationSchema = z.object({
  key: z.string(),
  kind: z.enum(["local", "ssh", "wsl"]),
  path: z.string(),
  host: z.string().optional(),
  label: z.string(),
});

export const NoteStorageEntrySchema = z.object({
  location: NoteLocationSchema,
  notes: NumberSchema,
  bytes: z.object({
    text: NumberSchema,
    sketches: NumberSchema,
    files: NumberSchema,
    images: NumberSchema,
    recordings: NumberSchema,
  }),
  updatedAt: NumberSchema,
  /** The workspaces open in the app whose folder this is. */
  workspaceIds: z.array(z.string()),
});

const ws = { workspaceId: WorkspaceIdSchema };
const note = { ...ws, noteId: NoteIdSchema };
const recording = { ...note, recordingId: RecordingIdSchema };
const asset = { ...note, src: z.string().min(1).max(1024) };

export const NotesArgs = {
  list: z.object(ws),
  create: z.object({ ...ws, title: z.string().max(500).optional() }),
  read: z.object(note),
  links: z.object(note),
  linksOfConversation: NoteConversationSchema,
  summaries: z.object(note),
  summaryVisibility: z.object({ ...note, tabId: z.string().min(1).max(256), visible: z.boolean() }),
  summarize: z.object({ ...recording, mode: SummaryModeSchema.optional() }),
  cancel: z.object(recording),
  undo: z.object(recording),
  dismiss: z.object(recording),
  addLink: z.object({
    ...note,
    link: NewNoteLinkSchema,
    touchExisting: z.union([z.literal(true), NoteLinkIdSchema]).optional(),
  }),
  updateLink: z.union([
    z.object({ ...note, linkId: NoteLinkIdSchema, patch: NoteLinkPatchSchema }),
    z.object({ tab: NoteLinkTargetSchema.extend({ agent: NewNoteLinkSchema.shape.agent }) }),
  ]),
  removeLink: z.object({ ...note, linkId: NoteLinkIdSchema }),
  save: z.object({
    ...note,
    title: z.string().max(500).optional(),
    doc: NoteDocSchema.optional(),
    baseUpdatedAt: NonnegativeNumberSchema.optional(),
  }),
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
  hasRecordingAudio: z.object({ ...note, files: z.array(z.string().regex(TAKE_FILE_RE)) }),
  saveTranscript: z.object({
    ...note,
    edits: z.array(TranscriptEditSchema),
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
  /** A line's audio (16 kHz, at most 10 s), for its voice print. */
  voicePrint: z.object({
    audio: z.custom<Float32Array>(
      (v) => v instanceof Float32Array && v.length <= MAX_VOICE_PRINT_SAMPLES,
      "16 kHz samples",
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
        recordedMs: NonnegativeNumberSchema,
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
  /** Workspaces that use the deleted location, for a whole-location removal. */
  workspaceIds: z.array(WorkspaceIdSchema).optional(),
  /** What happened to it. */
  change: z.enum(["created", "saved", "removed"]),
});
export type NoteChanged = z.infer<typeof NoteChangedSchema>;

export const NoteLinksChangedSchema = z.object({ locationKey: z.string(), noteId: NoteIdSchema });
export type NoteLinksChanged = z.infer<typeof NoteLinksChangedSchema>;

/** A photo another device put into a note (notes.attach), for the windows that have it open. */
export const NotePhotoAddedSchema = z.object({
  locationKey: z.string(),
  noteId: z.string(),
  /** Where the note keeps it: "screens/…". */
  src: z.string(),
  name: z.string(),
});
export type NotePhotoAdded = z.infer<typeof NotePhotoAddedSchema>;

/**
 * Blocks an agent put into a note (nexus note write, add), written into it
 * already: at its end, or at the end of the part under the heading `under`
 * names. An editor open on the note puts them in its copy too.
 */
export const NoteBlocksAddedSchema = z.object({
  locationKey: z.string(),
  noteId: z.string(),
  blocks: z.array(z.record(z.string(), z.unknown())),
  under: z.string().optional(),
});
export type NoteBlocksAdded = z.infer<typeof NoteBlocksAddedSchema>;

export const NoteBlocksRemovedSchema = z.object({
  locationKey: z.string(),
  noteId: NoteIdSchema,
  origin: z.string(),
});
export type NoteBlocksRemoved = z.infer<typeof NoteBlocksRemovedSchema>;

export const NoteSummaryChangedSchema = z.object({
  locationKey: z.string(),
  noteId: NoteIdSchema,
  recordingId: RecordingIdSchema,
  summary: RecordingSummarySchema,
});
export type NoteSummaryChanged = z.infer<typeof NoteSummaryChangedSchema>;

export const NoteSummaryCompletedSchema = z.object({
  ...note,
  title: z.string(),
  runId: z.uuid(),
  todos: z.number().int().nonnegative(),
});
export type NoteSummaryCompleted = z.infer<typeof NoteSummaryCompletedSchema>;

export const NoteLineReportedSchema = NoteLinksChangedSchema.extend({
  linkId: NoteLinkIdSchema,
  check: z.boolean(),
  result: NoteLinkResultSchema,
  updatedAt: NonnegativeNumberSchema,
});
export type NoteLineReported = z.infer<typeof NoteLineReportedSchema>;
