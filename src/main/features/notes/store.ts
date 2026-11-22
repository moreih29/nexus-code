/**
 * Notes on disk, under the app's data folder:
 *
 *   notes/<location dir>/location.json        where the workspace's folder is
 *   notes/<location dir>/<note id>/note.json  the note (its editor document)
 *   notes/<location dir>/<note id>/note.md    the same as Markdown, for agents
 *   notes/<location dir>/<note id>/links.json the note's linked conversations
 *   notes/<location dir>/<note id>/sketches/  <sketch id>.excalidraw and .svg
 *   notes/<location dir>/<note id>/materials/ files put into the note
 *   notes/<location dir>/<note id>/screens/   pasted images
 *   notes/<location dir>/<note id>/recordings/ the audio of its recordings
 *   notes/<location dir>/<note id>/transcript.json, .md  what was said in them
 *
 * The location dir is a hash of the location's key, so a workspace's notes
 * are found again from its folder whatever the workspace's id.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createLogger } from "../../../shared/log/main";
import { withBlocks } from "../../../shared/notes/insert";
import {
  MAX_EARLIER_SESSIONS,
  MAX_NOTE_LINK_BYTES,
  MAX_NOTE_LINKS,
  type NewNoteLink,
  type NoteLink,
  type NoteLinkEntry,
  NoteLinkIdSchema,
  type NoteLinkPatch,
  NoteLinkSchema,
  type NoteLinkTarget,
} from "../../../shared/notes/links";
import { type DocNode, docToMarkdown } from "../../../shared/notes/markdown";
import {
  EMPTY_TRANSCRIPT,
  numberSpeakers,
  peopleIn,
  RECORDING_ID_RE,
  recordingMs,
  TAKE_FILE_RE,
  type TranscriptEdit,
  type TranscriptFile,
  TranscriptFileSchema,
  type TranscriptRecording,
  transcriptMarkdown,
} from "../../../shared/notes/transcript";
import {
  imageBlock,
  NOTE_DIRS,
  NOTE_ID_RE,
  type NoteAsset,
  type NoteContent,
  type NoteCounts,
  type NoteFile,
  type NoteLocation,
  type NoteRecordingSummary,
  type NoteStorageEntry,
  type NoteSummary,
  SKETCH_ID_RE,
} from "../../../shared/notes/types";

const log = createLogger("notes");

const EMPTY_DOC: DocNode = { type: "doc", content: [{ type: "paragraph" }] };
const LINKS_JSON = "links.json";
const LinksFileSchema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string(), z.unknown()),
  summaries: z.record(z.string(), z.unknown()).catch({}),
});

interface LinksFile {
  version: 1;
  conversations: Record<string, NoteLink>;
  summaries: Record<string, unknown>;
}

/** How long a file the note does not use is kept: one just written may be about to be. */
export const PRUNE_AFTER_MS = 10 * 60 * 1000;

export class NoteError extends Error {
  constructor(
    readonly code: "not-found" | "bad-request" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export function locationDirName(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function newNoteId(now = Date.now()): string {
  return `n${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

export function newSketchId(now = Date.now()): string {
  return `s${now.toString(36)}${randomBytes(2).toString("hex")}`;
}

export class NotesStore {
  /** Serializes document updates by note folder. */
  private readonly documentTurns = new Map<string, Promise<void>>();
  private readonly transcriptTurns = new Map<string, Promise<void>>();
  private readonly linkTurns = new Map<string, Promise<void>>();
  private readonly linkTargetTurns = new Map<string, Promise<void>>();

  constructor(
    /** The notes folder: <app data>/notes. */
    readonly root: string,
    /** Moves a folder or file somewhere it can be got back from (the Trash); deletes it if not given. */
    private readonly trash?: (dir: string) => Promise<void>,
  ) {}

  locationDir(location: NoteLocation): string {
    return path.join(this.root, locationDirName(location.key));
  }

  noteDir(location: NoteLocation, id: string): string {
    if (!NOTE_ID_RE.test(id)) throw new NoteError("bad-request", `not a note id: ${id}`);
    return path.join(this.locationDir(location), id);
  }

  async list(location: NoteLocation): Promise<NoteSummary[]> {
    const dir = this.locationDir(location);
    const names = await readdirSafe(dir);
    const out: NoteSummary[] = [];
    for (const name of names) {
      if (!NOTE_ID_RE.test(name)) continue;
      const noteDir = path.join(dir, name);
      const note = await readNote(noteDir).catch(() => null);
      if (note) out.push(summaryOf(note, await recordingSummary(noteDir)));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(location: NoteLocation, title = ""): Promise<NoteContent> {
    const now = Date.now();
    const id = newNoteId(now);
    const dir = this.noteDir(location, id);
    await fs.mkdir(dir, { recursive: true });
    await this.touchLocation(location);
    const note: NoteFile = {
      version: 1,
      id,
      title,
      createdAt: now,
      updatedAt: now,
      doc: EMPTY_DOC,
    };
    await writeNote(dir, note);
    return { ...summaryOf(note), doc: note.doc, dir };
  }

  async read(location: NoteLocation, id: string): Promise<NoteContent> {
    const dir = this.noteDir(location, id);
    const note = await readNote(dir).catch(() => {
      throw new NoteError("not-found", `no note ${id}`);
    });
    return { ...summaryOf(note, await recordingSummary(dir)), doc: note.doc, dir };
  }

  async save(
    location: NoteLocation,
    id: string,
    change: { title?: string; doc?: DocNode },
  ): Promise<NoteSummary> {
    const dir = this.noteDir(location, id);
    return this.queueWrite(this.documentTurns, dir, () => this.saveNote(location, id, dir, change));
  }

  private async saveNote(
    location: NoteLocation,
    id: string,
    dir: string,
    change: { title?: string; doc?: DocNode },
  ): Promise<NoteSummary> {
    const note = await readNote(dir).catch(() => {
      throw new NoteError("not-found", `no note ${id}`);
    });
    if (change.title !== undefined) note.title = change.title.slice(0, 500);
    if (change.doc !== undefined) {
      if (change.doc?.type !== "doc") throw new NoteError("bad-request", "not a document");
      note.doc = change.doc;
    }
    note.updatedAt = Math.max(Date.now(), note.updatedAt + 1);
    await writeNote(dir, note);
    await this.touchLocation(location);
    return summaryOf(note, await recordingSummary(dir));
  }

  async remove(location: NoteLocation, id: string): Promise<void> {
    const dir = this.noteDir(location, id);
    await this.queueWrite(this.linkTurns, dir, async () => {
      if (await exists(dir)) await this.discard(dir);
    });
  }

  async links(location: NoteLocation, id: string): Promise<NoteLinkEntry[]> {
    const file = await readLinks(this.noteDir(location, id));
    return Object.entries(file.conversations).map(([id, link]) => ({ id, link }));
  }

  async addLink(location: NoteLocation, id: string, link: NewNoteLink): Promise<NoteLinkEntry> {
    return this.editLinks(location, id, async (file, dir) => {
      if (Object.keys(file.conversations).length >= MAX_NOTE_LINKS)
        throw new NoteError("bad-request", "Too many conversations linked to this note");
      const linkId = `l${randomBytes(8).toString("hex")}`;
      const now = Date.now();
      const created = { ...link, createdAt: now, updatedAt: now };
      file.conversations[linkId] = created;
      await writeLinks(dir, file);
      return { id: linkId, link: created };
    });
  }

  async updateLink(
    location: NoteLocation,
    id: string,
    linkId: string,
    patch: NoteLinkPatch,
  ): Promise<boolean> {
    return this.editLinks(location, id, async (file, dir) => {
      if (!patchLink(file, linkId, patch)) return false;
      await writeLinks(dir, file);
      return true;
    });
  }

  /** A chat can receive its session while its note is closed, even after an app restart. */
  async updateLinksForTab(
    location: NoteLocation,
    { agent, ...tab }: NoteLinkTarget & Pick<NoteLink, "agent">,
    changed: (noteId: string) => void,
  ): Promise<void> {
    const locationDir = this.locationDir(location);
    await this.queueWrite(this.linkTargetTurns, locationDir, async () => {
      for (const noteId of await readdirSafe(locationDir)) {
        if (!NOTE_ID_RE.test(noteId)) continue;
        const dir = this.noteDir(location, noteId);
        await this.queueWrite(this.linkTurns, dir, async () => {
          const file = await readLinks(dir);
          let dirty = false;
          for (const [id, link] of Object.entries(file.conversations)) {
            if (
              link.agent !== agent ||
              link.tabId !== tab.tabId ||
              link.workspaceId !== tab.workspaceId
            )
              continue;
            if (patchLink(file, id, { ...tab, profileId: tab.profileId ?? null })) dirty = true;
          }
          if (!dirty || !(await exists(path.join(dir, "note.json")))) return;
          await writeLinks(dir, file);
          changed(noteId);
        });
      }
    });
  }

  async removeLink(location: NoteLocation, id: string, linkId: string): Promise<boolean> {
    return this.editLinks(location, id, async (file, dir) => {
      if (!Object.hasOwn(file.conversations, linkId)) return false;
      delete file.conversations[linkId];
      await writeLinks(dir, file);
      return true;
    });
  }

  private editLinks<T>(
    location: NoteLocation,
    id: string,
    edit: (file: LinksFile, dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = this.noteDir(location, id);
    return this.queueWrite(this.linkTurns, dir, async () => {
      await readNote(dir).catch(() => {
        throw new NoteError("not-found", `no note ${id}`);
      });
      return edit(await readLinks(dir), dir);
    });
  }

  /** Copies a file into the note's materials/, under a name not taken yet. */
  async addFile(location: NoteLocation, id: string, source: string): Promise<NoteAsset> {
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) throw new NoteError("bad-request", `not a file: ${source}`);
    const sub = path.join(this.noteDir(location, id), NOTE_DIRS.files);
    await fs.mkdir(sub, { recursive: true });
    const name = await claimFree(sub, safeName(path.basename(source)), (file) =>
      fs.copyFile(source, file, fsConstants.COPYFILE_EXCL),
    );
    return { src: `${NOTE_DIRS.files}/${name}`, name, size: stat.size };
  }

  /** Writes a pasted image into the note's screens/. */
  async addImage(
    location: NoteLocation,
    id: string,
    bytes: Uint8Array,
    ext: string,
    name?: string,
  ): Promise<NoteAsset> {
    if (!/^(png|jpe?g|gif|webp)$/.test(ext))
      throw new NoteError("bad-request", `not an image: ${ext}`);
    const sub = path.join(this.noteDir(location, id), NOTE_DIRS.images);
    await fs.mkdir(sub, { recursive: true });
    const base = name ? safeName(name).replace(/\.[^.]*$/, "") : `image-${stamp()}`;
    const file = await claimFree(sub, `${base}.${ext}`, (target) =>
      fs.writeFile(target, bytes, { flag: "wx" }),
    );
    return { src: `${NOTE_DIRS.images}/${file}`, name: file, size: bytes.byteLength };
  }

  /**
   * Writes a photo sent from another device into the note's screens/, and
   * puts it at the end of the note's document, so the note has it whether
   * or not it is open anywhere (an open editor puts the same block in its
   * copy, NotesFeature's photoAdded).
   */
  async addPhoto(
    location: NoteLocation,
    id: string,
    bytes: Uint8Array,
    ext: string,
    name?: string,
  ): Promise<NoteAsset> {
    // A note that is not there gets no file either.
    await this.read(location, id);
    const asset = await this.addImage(location, id, bytes, ext, name ?? `photo-${stamp()}`);
    await this.appendBlocks(location, id, [imageBlock(asset)]);
    return asset;
  }

  /**
   * Puts blocks into the note's document: at its end, or at the end of the
   * part under the heading `under` names (insertionIndex). Blocks that come
   * at once go in one after another: each reads the note as the one before
   * left it. A NoteError when `under` names no heading.
   */
  async appendBlocks(
    location: NoteLocation,
    id: string,
    blocks: DocNode[],
    under?: string,
  ): Promise<void> {
    const dir = this.noteDir(location, id);
    await this.queueWrite(this.documentTurns, dir, async () => {
      const note = await this.read(location, id);
      const doc = withBlocks(note.doc, blocks, under);
      if (!doc) throw new NoteError("bad-request", `no heading "${under}" in the note`);
      await this.saveNote(location, id, dir, { doc });
    });
  }

  /** Writes a file's bytes into the note's materials/, under a name not taken yet. */
  async addFileBytes(
    location: NoteLocation,
    id: string,
    bytes: Uint8Array,
    name: string,
  ): Promise<NoteAsset> {
    const sub = path.join(this.noteDir(location, id), NOTE_DIRS.files);
    await fs.mkdir(sub, { recursive: true });
    const file = await claimFree(sub, safeName(name), (target) =>
      fs.writeFile(target, bytes, { flag: "wx" }),
    );
    return { src: `${NOTE_DIRS.files}/${file}`, name: file, size: bytes.byteLength };
  }

  /** Writes a sketch's scene and its picture; a new sketch gets an id. */
  async saveSketch(
    location: NoteLocation,
    id: string,
    sketch: { id?: string; scene: string; svg: string },
  ): Promise<{ id: string; src: string; scene: string }> {
    const sketchId = sketch.id ?? newSketchId();
    if (!SKETCH_ID_RE.test(sketchId))
      throw new NoteError("bad-request", `not a sketch id: ${sketchId}`);
    const sub = path.join(this.noteDir(location, id), NOTE_DIRS.sketches);
    await fs.mkdir(sub, { recursive: true });
    await writeAtomic(path.join(sub, `${sketchId}.excalidraw`), sketch.scene);
    await writeAtomic(path.join(sub, `${sketchId}.svg`), sketch.svg);
    return {
      id: sketchId,
      src: `${NOTE_DIRS.sketches}/${sketchId}.svg`,
      scene: `${NOTE_DIRS.sketches}/${sketchId}.excalidraw`,
    };
  }

  /** The note's recordings and their words; an empty transcript when it has none. */
  async readTranscript(location: NoteLocation, id: string): Promise<TranscriptFile> {
    return readTranscript(this.noteDir(location, id));
  }

  /** Writes transcript.json, and transcript.md (with the note's title) beside it. */
  async saveTranscript(location: NoteLocation, id: string, file: TranscriptFile): Promise<void> {
    const dir = this.noteDir(location, id);
    await this.queueWrite(this.transcriptTurns, dir, () => this.writeTranscript(dir, id, file));
  }

  /** Applies only changed recordings to the latest file, across all windows and aliases. */
  async editTranscript(
    location: NoteLocation,
    id: string,
    edits: readonly TranscriptEdit[],
  ): Promise<void> {
    if (!edits.length) return;
    const dir = this.noteDir(location, id);
    await this.queueWrite(this.transcriptTurns, dir, async () => {
      const file = await readTranscript(dir);
      const recordings = new Map(file.recordings.map((recording) => [recording.id, recording]));
      for (const { id: recordingId, before, after } of edits) {
        if ((before && before.id !== recordingId) || (after && after.id !== recordingId))
          throw new NoteError("bad-request", "transcript edit has a different recording ID");
        const current = recordings.get(recordingId);
        if (sameRecording(current, after)) continue;
        if (!sameRecording(current, before))
          throw new NoteError("conflict", "The recording was changed in another window.");
        if (after) recordings.set(recordingId, after);
        else recordings.delete(recordingId);
      }
      await this.writeTranscript(dir, id, { ...file, recordings: [...recordings.values()] });
    });
  }

  private queueWrite<T>(
    turns: Map<string, Promise<void>>,
    dir: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const turn = (turns.get(dir) ?? Promise.resolve()).then(work);
    const settled = turn.then(
      () => {},
      () => {},
    );
    turns.set(dir, settled);
    void settled.then(() => {
      if (turns.get(dir) === settled) turns.delete(dir);
    });
    return turn;
  }

  private async writeTranscript(dir: string, id: string, file: TranscriptFile): Promise<void> {
    const note = await readNote(dir).catch(() => {
      throw new NoteError("not-found", `no note ${id}`);
    });
    await writeAtomic(path.join(dir, TRANSCRIPT_MD), transcriptMarkdown(file, note.title));
    await writeAtomic(path.join(dir, TRANSCRIPT_JSON), `${JSON.stringify(file)}\n`);
  }

  async hasRecordingAudio(
    location: NoteLocation,
    id: string,
    files: readonly string[],
  ): Promise<boolean> {
    if (!files.length) return false;
    const present = await Promise.all(
      files.map(async (file) => {
        if (!TAKE_FILE_RE.test(file)) return false;
        const stat = await fs.stat(this.assetPath(location, id, file)).catch(() => null);
        return Boolean(stat?.isFile() && stat.size > 0);
      }),
    );
    return present.every(Boolean);
  }

  /** Adds a piece of a take's audio to the end of its file, which the first piece makes. */
  async appendAudio(
    location: NoteLocation,
    id: string,
    file: string,
    audio: Uint8Array,
  ): Promise<void> {
    if (!TAKE_FILE_RE.test(file)) throw new NoteError("bad-request", `not a take's file: ${file}`);
    const dir = this.noteDir(location, id);
    if (!(await exists(path.join(dir, "note.json"))))
      throw new NoteError("not-found", `no note ${id}`);
    await fs.mkdir(path.join(dir, NOTE_DIRS.recordings), { recursive: true });
    await fs.appendFile(path.join(dir, file), audio);
  }

  /**
   * Moves a recording's audio to the Trash; its words stay, unless `text`
   * says they go too. The transcript as it is after.
   */
  async removeRecording(
    location: NoteLocation,
    id: string,
    recordingId: string,
    text = false,
  ): Promise<TranscriptFile> {
    if (!RECORDING_ID_RE.test(recordingId))
      throw new NoteError("bad-request", `not a recording id: ${recordingId}`);
    const dir = this.noteDir(location, id);
    return this.queueWrite(this.transcriptTurns, dir, async () => {
      const file = await readTranscript(dir);
      for (const name of await readdirSafe(path.join(dir, NOTE_DIRS.recordings))) {
        if (name.startsWith(`${recordingId}-`))
          await this.discard(path.join(dir, NOTE_DIRS.recordings, name));
      }
      const next: TranscriptFile = {
        ...file,
        recordings: text
          ? file.recordings.filter((r) => r.id !== recordingId)
          : file.recordings.map((r) => (r.id === recordingId ? { ...r, audioRemoved: true } : r)),
      };
      await this.writeTranscript(dir, id, next);
      return next;
    });
  }

  /**
   * Clears away, to the Trash, the files in a note's folder its document no
   * longer uses: a sketch, image or file whose block was deleted. Run as a
   * note opens, when no undo can bring such a block back. A file written in
   * the last PRUNE_AFTER_MS stays (another tab of the note may be about to
   * use it). Returns what it cleared, by place in the folder.
   */
  async prune(location: NoteLocation, id: string, now = Date.now()): Promise<string[]> {
    const dir = this.noteDir(location, id);
    const note = await readNote(dir).catch(() => {
      throw new NoteError("not-found", `no note ${id}`);
    });
    const used = assetsOf(note.doc);
    const unused: string[] = [];
    for (const sub of [NOTE_DIRS.sketches, NOTE_DIRS.files, NOTE_DIRS.images]) {
      for (const name of await readdirSafe(path.join(dir, sub))) {
        const src = `${sub}/${name}`;
        if (used.has(src)) continue;
        const stat = await fs.stat(path.join(dir, src)).catch(() => null);
        if (!stat?.isFile() || now - stat.mtimeMs < PRUNE_AFTER_MS) continue;
        unused.push(src);
      }
    }
    for (const src of unused) await this.discard(path.join(dir, src));
    return unused;
  }

  /** A file in the note's folder, by its path there; never outside it. */
  assetPath(location: NoteLocation, id: string, src: string): string {
    const dir = this.noteDir(location, id);
    const full = path.resolve(dir, src);
    if (!full.startsWith(dir + path.sep))
      throw new NoteError("bad-request", `outside the note: ${src}`);
    return full;
  }

  async readAsset(location: NoteLocation, id: string, src: string): Promise<Buffer> {
    return fs.readFile(this.assetPath(location, id, src)).catch(() => {
      throw new NoteError("not-found", `no ${src} in note ${id}`);
    });
  }

  /** Every location with notes, and what they take. */
  async storage(): Promise<NoteStorageEntry[]> {
    const out: NoteStorageEntry[] = [];
    for (const name of await readdirSafe(this.root)) {
      const dir = path.join(this.root, name);
      const location = await readJson<NoteLocation>(path.join(dir, "location.json")).catch(
        () => null,
      );
      if (!location) continue;
      const entry: NoteStorageEntry = {
        location,
        notes: 0,
        bytes: { text: 0, sketches: 0, files: 0, images: 0, recordings: 0 },
        updatedAt: 0,
      };
      for (const id of await readdirSafe(dir)) {
        if (!NOTE_ID_RE.test(id)) continue;
        const noteDir = path.join(dir, id);
        const note = await readNote(noteDir).catch(() => null);
        if (!note) continue;
        entry.notes++;
        entry.updatedAt = Math.max(entry.updatedAt, note.updatedAt);
        entry.bytes.text += await sizeOf(path.join(noteDir, "note.json"));
        entry.bytes.text += await sizeOf(path.join(noteDir, "note.md"));
        entry.bytes.text += await sizeOf(path.join(noteDir, LINKS_JSON));
        entry.bytes.text += await sizeOf(path.join(noteDir, TRANSCRIPT_JSON));
        entry.bytes.text += await sizeOf(path.join(noteDir, TRANSCRIPT_MD));
        entry.bytes.recordings += await sizeOf(path.join(noteDir, NOTE_DIRS.recordings));
        entry.bytes.sketches += await sizeOf(path.join(noteDir, NOTE_DIRS.sketches));
        entry.bytes.files += await sizeOf(path.join(noteDir, NOTE_DIRS.files));
        entry.bytes.images += await sizeOf(path.join(noteDir, NOTE_DIRS.images));
      }
      if (entry.notes) out.push(entry);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Removes every note of a location (by its key). */
  async removeLocation(key: string): Promise<void> {
    const dir = path.join(this.root, locationDirName(key));
    if (await exists(dir)) await this.discard(dir);
  }

  private async touchLocation(location: NoteLocation): Promise<void> {
    const dir = this.locationDir(location);
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, "location.json"), `${JSON.stringify(location, null, 2)}\n`);
  }

  private async discard(dir: string): Promise<void> {
    if (this.trash) {
      try {
        await this.trash(dir);
        return;
      } catch {
        // No Trash (a Linux without one): delete it.
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readLinks(dir: string): Promise<LinksFile> {
  const empty: LinksFile = { version: 1, conversations: {}, summaries: {} };
  try {
    const handle = await fs.open(path.join(dir, LINKS_JSON), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_NOTE_LINK_BYTES) return empty;
      const bytes = await handle.readFile();
      if (bytes.length > MAX_NOTE_LINK_BYTES) return empty;
      const file = LinksFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!file.success) return empty;
      empty.summaries = file.data.summaries;
      let count = 0;
      for (const [id, value] of Object.entries(file.data.conversations)) {
        if (!NoteLinkIdSchema.safeParse(id).success) continue;
        const link = NoteLinkSchema.safeParse(value);
        if (!link.success) continue;
        empty.conversations[id] = link.data;
        if (++count === MAX_NOTE_LINKS) break;
      }
      return empty;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return empty;
    throw error;
  }
}

async function writeLinks(dir: string, file: LinksFile): Promise<void> {
  const data = `${JSON.stringify(file)}\n`;
  if (Buffer.byteLength(data) > MAX_NOTE_LINK_BYTES)
    throw new NoteError("bad-request", "The note's linked conversations exceed 256 KB");
  await writeAtomic(path.join(dir, LINKS_JSON), data);
}

function patchLink(file: LinksFile, id: string, patch: NoteLinkPatch): boolean {
  if (!Object.hasOwn(file.conversations, id)) return false;
  const current = file.conversations[id];
  const { profileId, session, ...target } = patch;
  const next = { ...current, ...target };
  if (profileId === null) delete next.profileId;
  else if (profileId !== undefined) next.profileId = profileId;
  if (session !== undefined && session !== current.session) {
    next.session = session;
    const previous = current.session
      ? [current.session, ...(current.sessions ?? [])]
      : current.sessions;
    if (previous) {
      next.sessions = [...new Set(previous)]
        .filter((id) => id !== session)
        .slice(0, MAX_EARLIER_SESSIONS);
    }
  }
  if (isDeepStrictEqual(next, current)) return false;
  file.conversations[id] = { ...next, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
  return true;
}

/** What a note has in it, counted from its document. */
export function countsOf(doc: DocNode): NoteCounts {
  const counts: NoteCounts = { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 };
  const walk = (n: DocNode) => {
    if (n.type === "sketch") counts.sketches++;
    else if (n.type === "noteFile") counts.files++;
    else if (n.type === "noteImage") counts.images++;
    else if (n.type === "taskItem") {
      counts.todos++;
      if (n.attrs?.checked) counts.todosDone++;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return counts;
}

/** The files a document uses, by place in its note's folder. */
export function assetsOf(doc: DocNode): Set<string> {
  const used = new Set<string>();
  const walk = (n: DocNode) => {
    const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
    if (n.type === "sketch") {
      const id = typeof n.attrs?.id === "string" ? n.attrs.id : "";
      if (id) {
        used.add(`${NOTE_DIRS.sketches}/${id}.excalidraw`);
        used.add(`${NOTE_DIRS.sketches}/${id}.svg`);
      }
      if (src) used.add(src);
    } else if ((n.type === "noteImage" || n.type === "noteFile") && src) used.add(src);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return used;
}

/** The first words of a document's text. */
export function excerptOf(doc: DocNode, max = 120): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (n: DocNode): boolean => {
    if (n.type === "text" && n.text) {
      parts.push(n.text);
      length += n.text.length;
      return length >= max;
    }
    for (const c of n.content ?? []) {
      if (walk(c)) return true;
      if (c.type === "paragraph" || c.type === "heading") parts.push(" ");
    }
    return false;
  };
  walk(doc);
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, max);
}

function summaryOf(note: NoteFile, recording?: NoteRecordingSummary): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    counts: countsOf(note.doc),
    excerpt: excerptOf(note.doc),
    ...(recording ? { recording } : {}),
  };
}

function sameRecording(current?: TranscriptRecording, expected?: TranscriptRecording): boolean {
  if (current && !current.speakerNumbers && expected?.speakerNumbers)
    return isDeepStrictEqual(numberSpeakers(current), expected);
  return isDeepStrictEqual(current, expected);
}

const TRANSCRIPT_JSON = "transcript.json";
const TRANSCRIPT_MD = "transcript.md";

async function readTranscript(dir: string): Promise<TranscriptFile> {
  const raw = await readJson<unknown>(path.join(dir, TRANSCRIPT_JSON)).catch(() => null);
  if (raw === null) return EMPTY_TRANSCRIPT;
  const parsed = TranscriptFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_TRANSCRIPT;
}

/** What a note's recordings add up to; nothing for a note with none. */
async function recordingSummary(dir: string): Promise<NoteRecordingSummary | undefined> {
  const file = await readTranscript(dir);
  if (!file.recordings.length) return undefined;
  return {
    recordings: file.recordings.length,
    ms: file.recordings.reduce((ms, r) => ms + recordingMs(r), 0),
    people: file.recordings.reduce((most, r) => Math.max(most, peopleIn(r)), 0),
  };
}

/** The note as Markdown: its title, then its body. */
export function noteMarkdown(note: Pick<NoteFile, "title" | "doc">): string {
  const body = docToMarkdown(note.doc);
  const title = note.title.trim();
  return title ? `# ${title}\n\n${body}` : body;
}

async function readNote(dir: string): Promise<NoteFile> {
  const note = await readJson<NoteFile>(path.join(dir, "note.json"));
  if (note?.version !== 1 || typeof note.id !== "string") throw new Error("not a note");
  return note;
}

async function writeNote(dir: string, note: NoteFile): Promise<void> {
  await writeAtomic(path.join(dir, "note.json"), `${JSON.stringify(note)}\n`);
  await writeAtomic(path.join(dir, "note.md"), noteMarkdown(note));
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "wx");
  try {
    try {
      await fs.writeFile(handle, data);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`Could not remove temporary note file: ${String(cleanupError)}`);
      }
    }
    throw error;
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function sizeOf(p: string): Promise<number> {
  const stat = await fs.stat(p).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await readdirSafe(p)) total += await sizeOf(path.join(p, name));
  return total;
}

/** A file name with no folders or characters a file system refuses. */
export function safeName(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it takes out
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180)
    // Windows ignores a name's trailing dots and spaces.
    .replace(/[. ]+$/, "");
  if (!cleaned) return "file";
  // Names Windows keeps for devices, with any extension: "con.png" cannot be a file there.
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned;
}

/**
 * Makes a file in `dir` under `name`, or `name (2)`, `name (3)`… whichever
 * is free, with `create`, which fails with EEXIST where one is there (it
 * creates exclusively): two at once never take the same name, nor does one
 * write over a file of the same name.
 */
async function claimFree(
  dir: string,
  name: string,
  create: (file: string) => Promise<void>,
): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try {
      await create(path.join(dir, candidate));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
