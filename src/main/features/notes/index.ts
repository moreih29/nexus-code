// The notes IPC channel: a workspace's notes, kept under the app's data folder.

import * as path from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import type { NoteAsset, NoteLocation } from "../../../shared/notes/types";
import type { NoteChanged } from "../../../shared/types/notes";
import {
  rootPathFromLocation,
  type WorkspaceMeta,
  workspaceLocationKey,
} from "../../../shared/types/workspace";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { NotesStore } from "./store";

const c = ipcContract.notes.call;

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".excalidraw": "application/json",
  ".json": "application/json",
  ".md": "text/markdown",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
};

/** Where a workspace's folder is, as its notes are kept by; a task's notes are its parent's. */
export function noteLocationOf(meta: WorkspaceMeta, all: readonly WorkspaceMeta[]): NoteLocation {
  const parent = meta.task ? all.find((w) => w.id === meta.task?.parentId) : undefined;
  const ws = parent ?? meta;
  const loc = ws.location;
  const host =
    loc.kind === "ssh"
      ? `${loc.user ? `${loc.user}@` : ""}${loc.host}${loc.port && loc.port !== 22 ? `:${loc.port}` : ""}`
      : loc.kind === "wsl"
        ? loc.distro
        : undefined;
  return {
    key: workspaceLocationKey(loc),
    kind: loc.kind,
    path: rootPathFromLocation(loc),
    ...(host ? { host } : {}),
    label: ws.name,
  };
}

/** A note a window records into, as it last told (notes.recording). */
export interface NoteRecording {
  workspaceId: string;
  noteId: string;
  title: string;
  /** How long it had recorded at `at`. */
  recordedMs: number;
  at: number;
  paused: boolean;
}

export interface NotesFeature {
  readonly store: NotesStore;
  /** The workspace's notes' location; throws for a workspace the app does not have. */
  locationOf(workspaceId: string): NoteLocation;
  /** Tells the windows a note changed (the CLI's changes too). */
  changed(event: NoteChanged): void;
  /**
   * Puts a photo another device sent at the end of a note, and tells the
   * windows, so an editor open on the note puts it in its copy too.
   */
  attachPhoto(
    workspaceId: string,
    noteId: string,
    bytes: Uint8Array,
    ext: string,
    name?: string,
  ): Promise<NoteAsset>;
  /** The note a window records into, the one told last; none while nothing records. */
  recording(): NoteRecording | undefined;
}

export function registerNotesChannel(opts: {
  userData: string;
  workspaces: () => readonly WorkspaceMeta[];
}): NotesFeature {
  const store = new NotesStore(path.join(opts.userData, "notes"), (dir) => shell.trashItem(dir));
  const locationOf = (workspaceId: string): NoteLocation => {
    const all = opts.workspaces();
    const meta = all.find((w) => w.id === workspaceId);
    if (!meta) throw new Error(`no workspace ${workspaceId}`);
    return noteLocationOf(meta, all);
  };
  const changed = (event: NoteChanged) => broadcast("notes", "changed", event);

  // The windows' recorders, by window: what each told last.
  const recordings = new Map<number, NoteRecording>();
  const watched = new Set<number>();
  const recording = (): NoteRecording | undefined => {
    let last: NoteRecording | undefined;
    for (const r of recordings.values()) if (!last || r.at > last.at) last = r;
    return last;
  };
  const retitle = (noteId: string, title: string) => {
    for (const r of recordings.values()) if (r.noteId === noteId) r.title = title;
  };

  const attachPhoto: NotesFeature["attachPhoto"] = async (
    workspaceId,
    noteId,
    bytes,
    ext,
    name,
  ) => {
    const location = locationOf(workspaceId);
    const asset = await store.addPhoto(location, noteId, bytes, ext, name);
    broadcast("notes", "photoAdded", {
      locationKey: location.key,
      noteId,
      src: asset.src,
      name: asset.name,
    });
    changed({ locationKey: location.key, noteId, change: "saved" });
    return asset;
  };

  register("notes", {
    call: {
      list: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.list.args, args);
        return ipcOk(await store.list(locationOf(workspaceId)));
      },
      create: async (args: unknown) => {
        const { workspaceId, title } = validateArgs(c.create.args, args);
        const location = locationOf(workspaceId);
        const note = await store.create(location, title);
        changed({ locationKey: location.key, noteId: note.id, change: "created" });
        return ipcOk(note);
      },
      read: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.read.args, args);
        return ipcOk(await store.read(locationOf(workspaceId), noteId));
      },
      save: async (args: unknown) => {
        const { workspaceId, noteId, title, doc } = validateArgs(c.save.args, args);
        const location = locationOf(workspaceId);
        const summary = await store.save(location, noteId, {
          ...(title !== undefined ? { title } : {}),
          ...(doc !== undefined ? { doc: doc as never } : {}),
        });
        changed({ locationKey: location.key, noteId, change: "saved" });
        retitle(noteId, summary.title);
        return ipcOk(summary);
      },
      prune: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.prune.args, args);
        const location = locationOf(workspaceId);
        const removed = await store.prune(location, noteId);
        if (removed.length) changed({ locationKey: location.key, noteId, change: "saved" });
        return ipcOk(removed);
      },
      remove: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.remove.args, args);
        const location = locationOf(workspaceId);
        await store.remove(location, noteId);
        changed({ locationKey: location.key, noteId, change: "removed" });
        return ipcOk(undefined);
      },
      addFiles: async (args: unknown) => {
        const { workspaceId, noteId, paths } = validateArgs(c.addFiles.args, args);
        const location = locationOf(workspaceId);
        const out = [];
        for (const p of paths) out.push(await store.addFile(location, noteId, p));
        return ipcOk(out);
      },
      addImage: async (args: unknown) => {
        const { workspaceId, noteId, base64, ext, name } = validateArgs(c.addImage.args, args);
        const bytes = Buffer.from(base64, "base64");
        return ipcOk(
          await store.addImage(
            locationOf(workspaceId),
            noteId,
            bytes,
            ext === "jpeg" ? "jpg" : ext,
            name,
          ),
        );
      },
      saveSketch: async (args: unknown) => {
        const { workspaceId, noteId, sketchId, scene, svg } = validateArgs(c.saveSketch.args, args);
        return ipcOk(
          await store.saveSketch(locationOf(workspaceId), noteId, {
            ...(sketchId ? { id: sketchId } : {}),
            scene,
            svg,
          }),
        );
      },
      readAsset: async (args: unknown) => {
        const { workspaceId, noteId, src } = validateArgs(c.readAsset.args, args);
        const bytes = await store.readAsset(locationOf(workspaceId), noteId, src);
        const mime = MIME[path.extname(src).toLowerCase()] ?? "application/octet-stream";
        return ipcOk({ base64: bytes.toString("base64"), mime });
      },
      openAsset: async (args: unknown) => {
        const { workspaceId, noteId, src } = validateArgs(c.openAsset.args, args);
        const error = await shell.openPath(store.assetPath(locationOf(workspaceId), noteId, src));
        if (error) throw new Error(error);
        return ipcOk(undefined);
      },
      revealAsset: async (args: unknown) => {
        const { workspaceId, noteId, src } = validateArgs(c.revealAsset.args, args);
        shell.showItemInFolder(store.assetPath(locationOf(workspaceId), noteId, src));
        return ipcOk(undefined);
      },
      revealNote: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.revealNote.args, args);
        shell.showItemInFolder(
          path.join(store.noteDir(locationOf(workspaceId), noteId), "note.md"),
        );
        return ipcOk(undefined);
      },
      pickFiles: async (args: unknown) => {
        const { images } = validateArgs(c.pickFiles.args, args);
        const win = BrowserWindow.getFocusedWindow();
        const options: Electron.OpenDialogOptions = {
          properties: ["openFile", "multiSelections"],
          ...(images
            ? { filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] }
            : {}),
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        return ipcOk(result.canceled ? [] : result.filePaths);
      },
      storage: async () => {
        const all = opts.workspaces();
        const byKey = new Map<string, string[]>();
        for (const w of all) {
          if (w.task) continue;
          const key = workspaceLocationKey(w.location);
          byKey.set(key, [...(byKey.get(key) ?? []), w.id]);
        }
        const entries = await store.storage();
        return ipcOk(entries.map((e) => ({ ...e, workspaceIds: byKey.get(e.location.key) ?? [] })));
      },
      removeLocation: async (args: unknown) => {
        const { key } = validateArgs(c.removeLocation.args, args);
        await store.removeLocation(key);
        changed({ locationKey: key, change: "removed" });
        return ipcOk(undefined);
      },
      recording: async (args: unknown, ctx) => {
        const { now } = validateArgs(c.recording.args, args);
        const sender = ctx?.sender;
        if (!sender) return ipcOk(undefined);
        if (!now) {
          recordings.delete(sender.id);
          return ipcOk(undefined);
        }
        const before = recordings.get(sender.id);
        let title = before?.noteId === now.noteId ? before.title : "";
        if (before?.noteId !== now.noteId) {
          title = await store
            .read(locationOf(now.workspaceId), now.noteId)
            .then((n) => n.title)
            .catch(() => "");
        }
        // A window that goes stops recording.
        if (!watched.has(sender.id)) {
          watched.add(sender.id);
          sender.once("destroyed", () => {
            recordings.delete(sender.id);
            watched.delete(sender.id);
          });
        }
        recordings.set(sender.id, {
          workspaceId: now.workspaceId,
          noteId: now.noteId,
          title,
          recordedMs: now.recordedMs,
          at: Date.now(),
          paused: now.paused,
        });
        return ipcOk(undefined);
      },
      readTranscript: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.readTranscript.args, args);
        return ipcOk(await store.readTranscript(locationOf(workspaceId), noteId));
      },
      saveTranscript: async (args: unknown) => {
        const { workspaceId, noteId, transcript, announce } = validateArgs(
          c.saveTranscript.args,
          args,
        );
        const location = locationOf(workspaceId);
        await store.saveTranscript(location, noteId, transcript);
        if (announce) changed({ locationKey: location.key, noteId, change: "saved" });
        return ipcOk(undefined);
      },
      appendAudio: async (args: unknown) => {
        const { workspaceId, noteId, file, audio } = validateArgs(c.appendAudio.args, args);
        await store.appendAudio(locationOf(workspaceId), noteId, file, audio);
        return ipcOk(undefined);
      },
      removeRecording: async (args: unknown) => {
        const { workspaceId, noteId, recordingId, text } = validateArgs(
          c.removeRecording.args,
          args,
        );
        const location = locationOf(workspaceId);
        const next = await store.removeRecording(location, noteId, recordingId, text ?? false);
        changed({ locationKey: location.key, noteId, change: "saved" });
        return ipcOk(next);
      },
      revealLocation: async (args: unknown) => {
        const { key } = validateArgs(c.revealLocation.args, args);
        const dir = store.locationDir({ key, kind: "local", path: "", label: "" });
        shell.showItemInFolder(path.join(dir, "location.json"));
        return ipcOk(undefined);
      },
    },
    listen: {
      changed: {},
    },
  });

  return { store, locationOf, changed, attachPhoto, recording };
}
