// The notes IPC channel: a workspace's notes, kept under the app's data folder.

import * as path from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { LineReport } from "../../../shared/notes/line-report";
import type { NoteConversation } from "../../../shared/notes/links";
import type { DocNode } from "../../../shared/notes/markdown";
import { DEFAULT_RECORDING_SUMMARY_SETTINGS } from "../../../shared/notes/summary";
import {
  imageBlock,
  type NoteAsset,
  type NoteContent,
  type NoteLocation,
} from "../../../shared/notes/types";
import type { NoteChanged } from "../../../shared/types/notes";
import {
  rootPathFromLocation,
  type WorkspaceMeta,
  workspaceLocationKey,
} from "../../../shared/types/workspace";
import { broadcast, type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { VoicePrints } from "../voice-print";
import { getActiveAppWindow, getAppWindows } from "../window/app-windows";
import { NoteError, NotesStore } from "./store";
import { NotesSummary, type NotesSummaryOptions, type SummaryTarget } from "./summary";

const c = ipcContract.notes.call;
const NOTE_WRITE_CALLS: readonly string[] = [
  "create",
  "save",
  "addLink",
  "updateLink",
  "removeLink",
  "summarize",
  "cancel",
  "undo",
  "dismiss",
  "prune",
  "remove",
  "addFiles",
  "addImage",
  "saveSketch",
  "removeLocation",
  "saveTranscript",
  "appendAudio",
  "removeRecording",
] satisfies readonly (keyof typeof c)[];

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
  /** Drops recordings and in-flight reports for a removed workspace. */
  forgetWorkspace(workspaceId: string): void;
  /** Releases the notes feature's process and recording state at app shutdown. */
  dispose(): void;
  /** Waits for the note writes that were in progress at shutdown. */
  waitForWrites(): Promise<void>;
  /** Makes a note, and tells the windows. */
  create(workspaceId: string, title: string): Promise<NoteContent>;
  /**
   * Puts blocks into a note: at its end, or at the end of the part under
   * the heading `under` names; tells the windows, so an editor open on the
   * note puts them in its copy too.
   */
  append(workspaceId: string, noteId: string, blocks: DocNode[], under?: string): Promise<void>;
  reportLine(tab: NoteConversation, noteId: string, report: LineReport): Promise<boolean>;
  /**
   * Writes a file into a note's folder: an image into screens/, which it
   * shows, anything else into materials/. The block that shows it.
   */
  addAsset(
    workspaceId: string,
    noteId: string,
    bytes: Uint8Array,
    name: string,
  ): Promise<{ asset: NoteAsset; block: DocNode }>;
}

/** The images a note shows, by their extension, as the note keeps them. */
const IMAGE_EXTS: Readonly<Record<string, string>> = {
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".gif": "gif",
  ".webp": "webp",
};

type NoteCall = (args: unknown, ctx?: CallContext) => unknown;
type TrackWrite = <T>(write: () => Promise<T>) => Promise<T>;

/** Reports expected note failures before they reach the router's bug handler. */
function withNoteErrors(
  trackWrite: TrackWrite,
  handlers: Record<string, NoteCall>,
): Record<string, NoteCall> {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      async (args: unknown, ctx?: CallContext) => {
        try {
          if (NOTE_WRITE_CALLS.includes(method)) {
            return await trackWrite(async () => handler(args, ctx));
          }
          return await handler(args, ctx);
        } catch (error) {
          if (!(error instanceof NoteError)) throw error;
          if (error.code === "not-found" || error.code === "conflict") {
            return ipcErr(error.code, error.message, { category: "failed", code: error.code });
          }
          return ipcErr("invalid-args", error.message, {
            category: "invalid-input",
            code: error.code,
          });
        }
      },
    ]),
  );
}

export function registerNotesChannel(opts: {
  userData: string;
  workspaces: () => readonly WorkspaceMeta[];
  summary?: Pick<NotesSummaryOptions, "settings" | "language" | "profile" | "runClaude">;
}): NotesFeature {
  const store = new NotesStore(path.join(opts.userData, "notes"), (dir) => shell.trashItem(dir));
  const writes = new Set<Promise<unknown>>();
  /** Keeps the entire write in the shutdown set, including any awaited reads. */
  const trackWrite: TrackWrite = (write) => {
    const pending = write();
    writes.add(pending);
    const forget = () => writes.delete(pending);
    void pending.then(forget, forget);
    return pending;
  };
  const locationOf = (workspaceId: string): NoteLocation => {
    const all = opts.workspaces();
    const meta = all.find((w) => w.id === workspaceId);
    if (!meta) throw new NoteError("not-found", `no workspace ${workspaceId}`);
    return noteLocationOf(meta, all);
  };
  const changed = (event: NoteChanged) => broadcast("notes", "changed", event);
  const linksChanged = (locationKey: string, noteId: string) =>
    broadcast("notes", "linksChanged", { locationKey, noteId });
  // Beside the main bundle (electron.vite.config.ts).
  const voicePrints = new VoicePrints(path.join(__dirname, "voice-print-host.js"));
  const visibleNotes = new Map<number, Map<string, string>>();
  const noteKey = (locationKey: string, noteId: string) => JSON.stringify([locationKey, noteId]);
  const isWindowVisible = (win: BrowserWindow) => win.isVisible() && !win.isMinimized();
  const isNoteVisible = (key: string) =>
    getAppWindows().some(
      (win) =>
        isWindowVisible(win) &&
        Array.from(visibleNotes.get(win.webContents.id)?.values() ?? []).includes(key),
    );
  const notifySummary = async (
    locationKey: string,
    noteId: string,
    runId: string,
    todos: number,
  ) => {
    const key = noteKey(locationKey, noteId);
    if (isNoteVisible(key)) return;
    const workspaces = opts.workspaces();
    const matchesLocation = (item: WorkspaceMeta) =>
      noteLocationOf(item, workspaces).key === locationKey;
    const workspace =
      workspaces.find((item) => !item.task && matchesLocation(item)) ??
      workspaces.find(matchesLocation);
    if (!workspace || !getActiveAppWindow()) return;
    const { title } = await store.read(noteLocationOf(workspace, workspaces), noteId);
    if (isNoteVisible(key)) return;
    // Deliver the toast to a single app window, even though the banner is broadcast to all.
    const active = getActiveAppWindow();
    const destination =
      active && isWindowVisible(active)
        ? active
        : (getAppWindows().find(isWindowVisible) ?? active);
    destination?.webContents.send("ipc:event", "notes", "summaryCompleted", {
      workspaceId: workspace.id,
      noteId,
      title,
      runId,
      todos,
    });
  };

  // The windows' recorders, by window: what each told last.
  const recordings = new Map<number, NoteRecording>();
  const pendingRecordings = new Map<number, { workspaceId: string }>();
  /** Removes the current recording state of a workspace, including unfinished reports. */
  const forgetWorkspace = (workspaceId: string): void => {
    for (const byWindow of [recordings, pendingRecordings]) {
      for (const [senderId, value] of byWindow) {
        if (value.workspaceId === workspaceId) byWindow.delete(senderId);
      }
    }
  };
  const watched = new Set<number>();
  const recording = (): NoteRecording | undefined => {
    let last: NoteRecording | undefined;
    for (const r of recordings.values()) if (!last || r.at > last.at) last = r;
    return last;
  };
  const retitle = (noteId: string, title: string) => {
    for (const r of recordings.values()) if (r.noteId === noteId) r.title = title;
  };

  const attachPhoto: NotesFeature["attachPhoto"] = (workspaceId, noteId, bytes, ext, name) =>
    trackWrite(async () => {
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
    });

  const create: NotesFeature["create"] = (workspaceId, title) =>
    trackWrite(async () => {
      const location = locationOf(workspaceId);
      const note = await store.create(location, title);
      changed({ locationKey: location.key, noteId: note.id, change: "created" });
      return note;
    });
  const appendAtLocation = (
    location: NoteLocation,
    noteId: string,
    blocks: DocNode[],
    under?: string,
  ) =>
    trackWrite(async () => {
      await store.appendBlocks(location, noteId, blocks, under);
      broadcast("notes", "blocksAdded", {
        locationKey: location.key,
        noteId,
        blocks: blocks as unknown as Record<string, unknown>[],
        ...(under !== undefined ? { under } : {}),
      });
      changed({ locationKey: location.key, noteId, change: "saved" });
    });
  const append: NotesFeature["append"] = (workspaceId, noteId, blocks, under) =>
    appendAtLocation(locationOf(workspaceId), noteId, blocks, under);
  const summary = new NotesSummary({
    store,
    settings: opts.summary?.settings ?? (() => DEFAULT_RECORDING_SUMMARY_SETTINGS),
    language: opts.summary?.language ?? (() => "en"),
    profile: opts.summary?.profile ?? (() => null),
    runClaude: opts.summary?.runClaude ?? (async () => ({ error: { kind: "missing" } })),
    append: ({ location, noteId }, blocks) => appendAtLocation(location, noteId, blocks),
    onState: (locationKey, noteId, recordingId, state) => {
      broadcast("notes", "summaryChanged", { locationKey, noteId, recordingId, summary: state });
      if (state.state === "done" && !state.seen) {
        void notifySummary(locationKey, noteId, state.runId, state.todos).catch(() => {});
      }
    },
    onRemoved: ({ location, noteId }, origin) => {
      broadcast("notes", "blocksRemoved", { locationKey: location.key, noteId, origin });
      changed({ locationKey: location.key, noteId, change: "saved" });
    },
  });
  const summaryTarget = ({
    workspaceId,
    noteId,
    recordingId,
  }: {
    workspaceId: string;
    noteId: string;
    recordingId: string;
  }): SummaryTarget => ({ location: locationOf(workspaceId), noteId, recordingId });
  const reportLine: NotesFeature["reportLine"] = (tab, noteId, report) =>
    trackWrite(async () => {
      const location = locationOf(tab.workspaceId);
      const updated = await store.reportLine(location, tab, noteId, report);
      const place = { locationKey: location.key, noteId };
      broadcast("notes", "linksChanged", place);
      broadcast("notes", "lineReported", { ...place, ...report });
      if (updated) changed({ ...place, change: "saved" });
      return updated;
    });
  const addAsset: NotesFeature["addAsset"] = (workspaceId, noteId, bytes, name) =>
    trackWrite(async () => {
      const location = locationOf(workspaceId);
      // A note that is not there gets no file either.
      await store.read(location, noteId);
      const ext = IMAGE_EXTS[path.extname(name).toLowerCase()];
      if (ext) {
        const asset = await store.addImage(location, noteId, bytes, ext, name);
        return { asset, block: imageBlock(asset) };
      }
      const asset = await store.addFileBytes(location, noteId, bytes, name);
      return {
        asset,
        block: { type: "noteFile", attrs: { src: asset.src, name: asset.name, size: asset.size } },
      };
    });

  register("notes", {
    keepOnRendererClose: NOTE_WRITE_CALLS,
    call: withNoteErrors(trackWrite, {
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
      links: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.links.args, args);
        return ipcOk(await store.links(locationOf(workspaceId), noteId));
      },
      linksOfConversation: async (args: unknown) => {
        const tab = validateArgs(c.linksOfConversation.args, args);
        return ipcOk(await store.linksOfConversation(locationOf(tab.workspaceId), tab));
      },
      summaries: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.summaries.args, args);
        return ipcOk(await summary.states(locationOf(workspaceId), noteId));
      },
      summaryVisibility: (args: unknown, ctx) => {
        const { workspaceId, noteId, tabId, visible } = validateArgs(
          c.summaryVisibility.args,
          args,
        );
        const sender = ctx?.sender;
        if (!sender || sender.isDestroyed()) return ipcOk(undefined);
        const tabs = visibleNotes.get(sender.id);
        if (!visible) {
          tabs?.delete(tabId);
        } else {
          const key = noteKey(locationOf(workspaceId).key, noteId);
          if (tabs) tabs.set(tabId, key);
          else {
            visibleNotes.set(sender.id, new Map([[tabId, key]]));
            sender.once("destroyed", () => visibleNotes.delete(sender.id));
          }
        }
        return ipcOk(undefined);
      },
      summarize: async (args: unknown) => {
        const request = validateArgs(c.summarize.args, args);
        return ipcOk(await summary.summarize(summaryTarget(request), request.mode ?? "auto"));
      },
      cancel: async (args: unknown) =>
        ipcOk(await summary.cancel(summaryTarget(validateArgs(c.cancel.args, args)))),
      undo: async (args: unknown) =>
        ipcOk(await summary.undo(summaryTarget(validateArgs(c.undo.args, args)))),
      dismiss: async (args: unknown) =>
        ipcOk(await summary.dismiss(summaryTarget(validateArgs(c.dismiss.args, args)))),
      addLink: async (args: unknown) => {
        const { workspaceId, noteId, link, touchExisting } = validateArgs(c.addLink.args, args);
        const location = locationOf(workspaceId);
        const entry = await store.addLink(location, noteId, link, touchExisting);
        linksChanged(location.key, noteId);
        return ipcOk(entry);
      },
      updateLink: async (args: unknown) => {
        const update = validateArgs(c.updateLink.args, args);
        if ("tab" in update) {
          const location = locationOf(update.tab.workspaceId);
          await store.updateLinksForTab(location, update.tab, (noteId) =>
            linksChanged(location.key, noteId),
          );
        } else {
          const location = locationOf(update.workspaceId);
          if (await store.updateLink(location, update.noteId, update.linkId, update.patch))
            linksChanged(location.key, update.noteId);
        }
        return ipcOk(undefined);
      },
      removeLink: async (args: unknown) => {
        const { workspaceId, noteId, linkId } = validateArgs(c.removeLink.args, args);
        const location = locationOf(workspaceId);
        if (await store.removeLink(location, noteId, linkId)) linksChanged(location.key, noteId);
        return ipcOk(undefined);
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
        const workspaces = opts.workspaces();
        const workspaceIds = workspaces
          .filter((workspace) => noteLocationOf(workspace, workspaces).key === key)
          .map((workspace) => workspace.id);
        changed({ locationKey: key, change: "removed", workspaceIds });
        return ipcOk(undefined);
      },
      recording: async (args: unknown, ctx) => {
        const { now } = validateArgs(c.recording.args, args);
        const sender = ctx?.sender;
        if (!sender || sender.isDestroyed()) return ipcOk(undefined);
        const senderId = sender.id;
        if (!now) {
          pendingRecordings.delete(senderId);
          recordings.delete(senderId);
          return ipcOk(undefined);
        }
        // Install the lifetime guard before looking up a title or touching disk.
        if (!watched.has(senderId)) {
          watched.add(senderId);
          sender.once("destroyed", () => {
            pendingRecordings.delete(senderId);
            recordings.delete(senderId);
            watched.delete(senderId);
          });
        }
        pendingRecordings.set(senderId, now);
        try {
          const before = recordings.get(senderId);
          const title =
            before?.noteId === now.noteId
              ? before.title
              : await store
                  .read(locationOf(now.workspaceId), now.noteId)
                  .then((note) => note.title)
                  .catch(() => "");
          if (pendingRecordings.get(senderId) === now) {
            recordings.set(senderId, {
              workspaceId: now.workspaceId,
              noteId: now.noteId,
              title,
              recordedMs: now.recordedMs,
              at: Date.now(),
              paused: now.paused,
            });
          }
        } finally {
          if (pendingRecordings.get(senderId) === now) pendingRecordings.delete(senderId);
        }
        return ipcOk(undefined);
      },
      readTranscript: async (args: unknown) => {
        const { workspaceId, noteId } = validateArgs(c.readTranscript.args, args);
        return ipcOk(await store.readTranscript(locationOf(workspaceId), noteId));
      },
      saveTranscript: async (args: unknown) => {
        const { workspaceId, noteId, edits, announce } = validateArgs(c.saveTranscript.args, args);
        const location = locationOf(workspaceId);
        await store.editTranscript(location, noteId, edits);
        if (announce) changed({ locationKey: location.key, noteId, change: "saved" });
        return ipcOk(undefined);
      },
      hasRecordingAudio: async (args: unknown) => {
        const { workspaceId, noteId, files } = validateArgs(c.hasRecordingAudio.args, args);
        return ipcOk(await store.hasRecordingAudio(locationOf(workspaceId), noteId, files));
      },
      appendAudio: async (args: unknown) => {
        const { workspaceId, noteId, file, audio } = validateArgs(c.appendAudio.args, args);
        await store.appendAudio(locationOf(workspaceId), noteId, file, audio);
        return ipcOk(undefined);
      },
      voicePrint: async (args: unknown) => {
        const { audio } = validateArgs(c.voicePrint.args, args);
        return ipcOk(await voicePrints.vector(audio));
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
    }),
    listen: {
      changed: {},
      linksChanged: {},
      summaryChanged: {},
      summaryCompleted: {},
      blocksAdded: {},
      blocksRemoved: {},
      lineReported: {},
    },
  });

  return {
    store,
    locationOf,
    changed,
    attachPhoto,
    recording,
    forgetWorkspace,
    waitForWrites: async () => {
      const results = await Promise.allSettled(writes);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      await summary.waitForIdle();
    },
    dispose: () => {
      summary.dispose();
      visibleNotes.clear();
      pendingRecordings.clear();
      recordings.clear();
      voicePrints.stop();
    },
    create,
    append,
    reportLine,
    addAsset,
  };
}
