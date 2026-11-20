/** nexus note list|read|path: the workspace's notes, kept by the app. */

import path from "node:path";
import type { RpcResult } from "../../../../../packages/remote-protocol/src";
import type { CliRecorder } from "../../../../shared/cli/ui";
import { imagesOf, markdownToBlocks } from "../../../../shared/notes/from-markdown";
import { insertionIndex } from "../../../../shared/notes/insert";
import type { DocNode } from "../../../../shared/notes/markdown";
import {
  clockOf,
  type ParticipantCount,
  transcriptLinesForCli,
  transcriptMarkdown,
} from "../../../../shared/notes/transcript";
import type { NoteAsset, NoteContent, NoteSummary } from "../../../../shared/notes/types";
import { noteMarkdown } from "../../notes/store";
import { CliUsageError, exactArgs, type ParsedArgs } from "../args";
import { type CliContext, CliError, mayChange, pick, resolveWorkspace } from "../context";
import { ago, oneLine, table } from "../format";
import { callerPath, onAppMachine } from "../paths";

import { type CliCommand, output } from "../registry";
import {
  askPeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerWorkspace,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { WORKSPACE_FLAG } from "./flags";

/** When a note was last written: how long ago within two days, else its date. */
function when(at: number, now: number): string {
  if (now - at < 48 * 3600 * 1000) return ago(at, now);
  return new Date(at).toISOString().slice(0, 10);
}

const NOTE_ARG_HELP =
  "A note is named by its id, an id prefix, or its title (as nexus note list shows them).";

/** What a note has in it, in a few words. */
export function contentsOf(note: Pick<NoteSummary, "counts" | "recording">): string {
  const { sketches, files, images, todos, todosDone } = note.counts;
  const parts: string[] = [];
  if (note.recording) parts.push(`recording ${clockOf(note.recording.ms)}`);
  if (todos) parts.push(`to-dos ${todosDone}/${todos}`);
  if (sketches) parts.push(`${sketches} sketch${sketches === 1 ? "" : "es"}`);
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  return parts.join(", ") || "text";
}

async function findNote(
  ctx: CliContext,
  workspaceId: string,
  selector: string,
): Promise<NoteContent> {
  const notes = await ctx.services.notes.list(workspaceId);
  const found = pick(
    notes,
    selector,
    (n) => n.id,
    (n) => n.title,
    "note",
  );
  return ctx.services.notes.read(workspaceId, found.id);
}

async function notePeer(ctx: CliContext, flags: ParsedArgs["flags"]) {
  const device = await resolveDevice(ctx, deviceFlag(flags));
  if (!device) return null;
  requirePeerCli(ctx, device);
  return { device, workspace: await peerWorkspace(ctx, device, flags.workspace) };
}

const list: CliCommand = {
  path: ["note", "list"],
  summary: "List the workspace's notes, newest first",
  details:
    "Notes are kept by the app (not in the workspace's folder), by where the workspace's\n" +
    "folder is. Read one with nexus note read.",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const peer = await notePeer(ctx, flags);
    if (peer) {
      const { notes } = await askPeerCli(ctx, peer.device, "notes.list", {
        workspaceId: peer.workspace.id,
      });
      const text = table(
        ["ID", "TITLE", "UPDATED"],
        notes.map((note) => [
          note.id,
          oneLine(note.title || "(untitled)", 50),
          when(note.updatedAt, ctx.services.clock.now()),
        ]),
      );
      return output(text || `No notes in ${peer.workspace.name}.`, {
        device: deviceRef(peer.device),
        notes,
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const notes = await ctx.services.notes.list(workspace.id);
    if (notes.length === 0) return output(`No notes in ${workspace.name}.`, { notes });
    const now = ctx.services.clock.now();
    return output(
      table(
        ["ID", "TITLE", "UPDATED", "HAS"],
        notes.map((n) => [
          n.id,
          oneLine(n.title || "(untitled)", 50),
          when(n.updatedAt, now),
          contentsOf(n),
        ]),
      ),
      { notes },
    );
  },
};

const read: CliCommand = {
  path: ["note", "read"],
  summary: "Print a note as Markdown",
  args: "<note>",
  details:
    `${NOTE_ARG_HELP}\n` +
    "Its sketches, images and files are linked by their place in the note's folder\n" +
    "(sketches/, screens/, materials/); in a terminal on the app's machine the folder's\n" +
    "path is printed after it, and nexus note path prints it alone. A note with\n" +
    "recordings has what was said in them after it, a voice and a time to a line.",
  flags: {
    transcript: { type: "boolean", description: "Only what was said in its recordings" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "note") as [string];
    const peer = await notePeer(ctx, flags);
    if (peer) {
      const note = await askPeerCli(ctx, peer.device, "notes.read", {
        workspaceId: peer.workspace.id,
        note: selector,
        transcriptOnly: flags.transcript === true,
      });
      const text =
        flags.transcript === true
          ? note.transcript || `${named(note)} has no recordings.`
          : `${note.markdown || "(empty note)\n"}${note.transcript ? `\n---\n\n${note.transcript}` : ""}`;
      return output(text.trimEnd(), { device: deviceRef(peer.device), ...note });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector);
    if (flags.transcript === true) {
      const said = transcriptMarkdown(
        await ctx.services.notes.transcript(workspace.id, note.id),
        note.title,
      );
      return output(said.replace(/\n$/, "") || `${note.title || note.id} has no recordings.`, {
        id: note.id,
        title: note.title,
        transcript: said,
      });
    }
    const markdown = noteMarkdown(note);
    const local = onAppMachine(ctx);
    const { sketches, files, images } = note.counts;
    const transcript = note.recording
      ? transcriptMarkdown(await ctx.services.notes.transcript(workspace.id, note.id), note.title)
      : "";
    const footer =
      local && sketches + files + images > 0 ? `\n<!-- The note's files: ${note.dir} -->\n` : "";
    const text = `${markdown || "(empty note)\n"}${transcript ? `\n---\n\n${transcript}` : ""}${footer}`;
    return output(text.replace(/\n$/, ""), {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
      markdown,
      ...(transcript ? { transcript } : {}),
      ...(local ? { dir: note.dir } : {}),
    });
  },
};

const noteTranscript: CliCommand = {
  path: ["note", "transcript"],
  summary: "List the lines and speakers of a note's recordings",
  args: "<note>",
  details: `${NOTE_ARG_HELP} Times are milliseconds from the start of each recording.`,
  flags: {
    recording: { type: "string", value: "ID", description: "Only this recording (id or prefix)" },
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "note") as [string];
    const recordingId = typeof flags.recording === "string" ? flags.recording : undefined;
    const peer = await notePeer(ctx, flags);
    if (peer) {
      const note = await askPeerCli(ctx, peer.device, "notes.transcript", {
        workspaceId: peer.workspace.id,
        note: selector,
        recording: recordingId,
      });
      return transcriptOutput({ device: deviceRef(peer.device), ...note });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector);
    const { recordings } = await ctx.services.notes.transcript(workspace.id, note.id);
    const wanted =
      recordingId !== undefined
        ? [
            pick(
              recordings,
              recordingId,
              (r) => r.id,
              (r) => r.id,
              "recording",
            ),
          ]
        : recordings;
    const shown = wanted.map((recording) => ({
      id: recording.id,
      startedAt: recording.startedAt,
      participants: recording.participantCount ?? "auto",
      lines: transcriptLinesForCli(recording),
    }));
    return transcriptOutput({ id: note.id, title: note.title, recordings: shown });
  },
};

function transcriptOutput(
  note: RpcResult<"notes.transcript"> & { device?: ReturnType<typeof deviceRef> },
) {
  const text = note.recordings
    .map((recording) =>
      [
        `Recording ${recording.id}`,
        ...recording.lines.map(
          (line) =>
            `  ${line.id} [${clockOf(line.startMs)}] ${line.speakerName ?? line.speakerLabel}: ${line.text}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
  return output(text || `${named(note)} has no recordings.`, note, { records: note.recordings });
}

const notePath: CliCommand = {
  path: ["note", "path"],
  summary: "Print the folder a note's files are kept in",
  args: "<note>",
  details:
    `${NOTE_ARG_HELP}\n` +
    "The folder is on the machine the app runs on: a terminal of an SSH or WSL workspace\n" +
    "cannot open it; read the note with nexus note read there.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "note");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    if (!onAppMachine(ctx))
      throw new CliError(
        "the note's folder is on the app's machine, not where this terminal is: use nexus note read",
      );
    const note = await findNote(ctx, workspace.id, selector as string);
    return output(note.dir, { id: note.id, dir: note.dir });
  },
};

/** A note as the text names it: its title and id. */
function named(note: { readonly id: string; readonly title: string }): string {
  return note.title ? `"${note.title}" (${note.id})` : note.id;
}

const noteNew: CliCommand = {
  path: ["note", "new"],
  summary: "Make a note, and print its id",
  args: "[title...]",
  details:
    "Kept with the workspace's notes. --show opens it in front of the user. Write into it\n" +
    "with nexus note write, put files in with nexus note add.",
  flags: {
    show: { type: "boolean", description: "Open it in front of the user" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const title = positionals.join(" ").trim();
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    await mayChange(ctx, workspace, { kind: "noteNew", detail: title || "untitled" });
    const note = await ctx.services.notes.create(workspace.id, title);
    if (flags.show === true) {
      await ctx.services.ui("note.show", { workspaceId: workspace.id, noteId: note.id, title });
    }
    const shown = flags.show === true ? " and opened it" : "";
    return output(`Made the note ${named(note)}${shown}.`, {
      id: note.id,
      title: note.title,
      workspaceId: workspace.id,
    });
  },
};

const noteShow: CliCommand = {
  path: ["note", "show"],
  summary: "Open a note in front of the user",
  args: "<note>",
  details: `${NOTE_ARG_HELP}\nIts workspace is shown, and its tab in front.`,
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "note");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector as string);
    await mayChange(ctx, workspace, { kind: "open", detail: note.title || note.id });
    await ctx.services.ui("note.show", {
      workspaceId: workspace.id,
      noteId: note.id,
      ...(note.title ? { title: note.title } : {}),
    });
    return output(`Opened the note ${named(note)}.`, { id: note.id, workspaceId: workspace.id });
  },
};

const UNDER_FLAG = {
  type: "string",
  value: "HEADING",
  description: "At the end of the part under this heading (its text), not of the note",
} as const;

/** A heading --under names, checked against the note before anything is written. */
function underFlag(flags: ParsedArgs["flags"], note: NoteContent): string | undefined {
  const under = flags.under as string | undefined;
  if (under === undefined) return undefined;
  if (under.trim() === "") throw new CliUsageError("--under takes a heading's text");
  if (insertionIndex(note.doc, under) === null) {
    throw new CliError(`${named(note)} has no heading "${under.trim()}"`);
  }
  return under;
}

/** A Markdown link's path as a file's: "chart%20a.png" is "chart a.png". */
function decoded(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

/** A file of the caller's computer, read where its terminal runs, put into the note. */
async function putFile(
  ctx: CliContext,
  workspaceId: string,
  note: NoteContent,
  file: string,
): Promise<{ asset: NoteAsset; block: DocNode }> {
  const where = callerPath(ctx, file);
  const data = await ctx.services.readFile(ctx.caller.workspaceId, where);
  if (data === null) throw new CliError(`no file ${where}`);
  return ctx.services.notes.addAsset(
    workspaceId,
    note.id,
    Buffer.from(data, "base64"),
    path.basename(where),
  );
}

const noteWrite: CliCommand = {
  path: ["note", "write"],
  summary: "Add Markdown to a note: at its end, or under one of its headings",
  args: "<note> <text...>",
  details:
    `${NOTE_ARG_HELP}\n` +
    'The text is Markdown ("-" reads it from standard input): headings, lists, to-dos\n' +
    "(- [ ]), quotes, code, links. An image (![what](chart.png)) is a file of this\n" +
    "computer, put into the note and shown there; one on the web is linked. What is in the\n" +
    "note stays: the text goes at its end, or with --under at the end of that heading's part.\n" +
    "A note open in the app gets it too, where the user sees it.",
  flags: { under: UNDER_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <note>");
    const fromStdin = words.length === 1 && words[0] === "-";
    const text = fromStdin ? (ctx.invocation.stdin ?? "") : words.join(" ");
    const blocks = markdownToBlocks(text);
    if (blocks.length === 0) throw new CliUsageError("nothing to write");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector);
    const under = underFlag(flags, note);
    await mayChange(ctx, workspace, {
      kind: "noteWrite",
      detail: note.title || note.id,
      body: text.trim(),
    });
    for (const image of imagesOf(blocks)) {
      const src = String(image.attrs?.src ?? "");
      if (/^(https?:|data:)/i.test(src) || src === "") {
        // A picture on the web: linked, as a note keeps only its own files.
        const alt = String(image.attrs?.alt ?? "");
        image.type = "paragraph";
        image.content = src.startsWith("http")
          ? [{ type: "text", text: alt || src, marks: [{ type: "link", attrs: { href: src } }] }]
          : alt
            ? [{ type: "text", text: alt }]
            : [];
        delete image.attrs;
        continue;
      }
      const { asset } = await putFile(ctx, workspace.id, note, decoded(src));
      image.attrs = { src: asset.src, alt: String(image.attrs?.alt ?? "") || asset.name };
    }
    await ctx.services.notes.append(workspace.id, note.id, blocks, under);
    const where = under ? ` under "${under.trim()}"` : "";
    return output(`Wrote into the note ${named(note)}${where}.`, {
      id: note.id,
      workspaceId: workspace.id,
      blocks: blocks.length,
      ...(under ? { under } : {}),
    });
  },
};

const noteAdd: CliCommand = {
  path: ["note", "add"],
  summary: "Put files into a note: images shown, other files as attachments",
  args: "<note> <file...>",
  details:
    `${NOTE_ARG_HELP}\n` +
    "Files of this computer (this terminal's), copied into the note's folder: an image\n" +
    "(png, jpg, gif, webp) into screens/ and shown, anything else into materials/. They\n" +
    "go at the note's end, or with --under at the end of that heading's part.",
  flags: { under: UNDER_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, ...files] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <note>");
    if (files.length === 0) throw new CliUsageError("missing <file>");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector);
    const under = underFlag(flags, note);
    await mayChange(ctx, workspace, {
      kind: "noteWrite",
      detail: note.title || note.id,
      body: files.map((f) => path.basename(f)).join("\n"),
    });
    const put = [];
    for (const file of files) put.push(await putFile(ctx, workspace.id, note, file));
    await ctx.services.notes.append(
      workspace.id,
      note.id,
      put.map((p) => p.block),
      under,
    );
    const assets = put.map((p) => p.asset);
    return output(
      `Put into the note ${named(note)}:\n${assets.map((a) => `  ${a.src}`).join("\n")}`,
      { id: note.id, workspaceId: workspace.id, assets },
    );
  },
};

/** The recorder as note record tells it. */
async function recorderText(ctx: CliContext, recorder: CliRecorder): Promise<string> {
  if (recorder.phase === "idle" || !recorder.workspaceId || !recorder.noteId) {
    const can =
      recorder.voice === "signed-out"
        ? "Recording needs a NexusCode sign-in (Settings › Remote)."
        : recorder.voice === "unavailable"
          ? "The NexusCode server signed in to has no voice recognition."
          : "A recording can start: nexus note record <note>. macOS asks for the microphone the first time.";
    return `Nothing records now. ${can}`;
  }
  const { workspaceId, noteId } = recorder;
  const note = await ctx.services.notes
    .read(workspaceId, noteId)
    .catch(() => ({ id: noteId, title: "" }));
  const at = clockOf(recorder.elapsedMs ?? 0);
  return recorder.phase === "paused"
    ? `The recording of ${named(note)} is paused at ${at}.`
    : `Recording into ${named(note)}: ${at} (${recorder.phase}).`;
}

const noteRecord: CliCommand = {
  path: ["note", "record"],
  summary: "Record into a note, or pause, go on or stop; with neither, tell what records",
  args: "[note]",
  details:
    `${NOTE_ARG_HELP}\n` +
    "Records what is said into the note, as its record button does, the note opened in front\n" +
    "of the user; nexus note read prints what was said so far. It takes the microphone: the\n" +
    "user allows it each time. One note records at a time. It needs a NexusCode sign-in on a\n" +
    "server with voice recognition; with no note, nexus note record says whether it can.",
  flags: {
    pause: { type: "boolean", description: "Pause the recording" },
    resume: { type: "boolean", description: "Go on with the paused recording" },
    stop: { type: "boolean", description: "Stop the recording" },
    participants: {
      type: "string",
      value: "N|auto",
      description: "The expected participant count when starting",
    },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 1) throw new CliUsageError("too many arguments");
    const [selector] = positionals;
    const acts = (["pause", "resume", "stop"] as const).filter((a) => flags[a] === true);
    if (acts.length > 1) throw new CliUsageError("--pause, --resume or --stop: one of them");
    const [act] = acts;
    const count = flags.participants as string | undefined;
    let participants: ParticipantCount | undefined;
    if (count !== undefined) {
      if (!selector || act)
        throw new CliUsageError("--participants goes with a note when starting");
      if (count === "auto") participants = count;
      else if (/^[1-9]\d*$/.test(count) && Number.isSafeInteger(Number(count)))
        participants = Number(count);
      else throw new CliUsageError("--participants takes a positive whole number or auto");
    }
    if (act && selector !== undefined) {
      throw new CliUsageError(`--${act} goes to the recording there is; leave out <note>`);
    }
    if (selector === undefined && !act) {
      const recorder = await ctx.services.ui("note.recorder", { action: "status" });
      return output(await recorderText(ctx, recorder), recorder);
    }
    if (act) {
      const now = await ctx.services.ui("note.recorder", { action: "status" });
      if (!now.workspaceId || !now.noteId) throw new CliError("nothing records now");
      const workspace = resolveWorkspace(ctx, now.workspaceId);
      const note = await ctx.services.notes
        .read(now.workspaceId, now.noteId)
        .catch(() => ({ id: now.noteId as string, title: "" }));
      const change = { detail: note.title || note.id };
      if (act === "resume") {
        await ctx.services.askUser({
          fromWorkspaceId: ctx.caller.workspaceId,
          fromTabId: ctx.caller.tabId,
          toWorkspaceId: workspace.id,
          change: { kind: "noteRecord", ...change },
        });
      } else {
        await mayChange(ctx, workspace, { kind: "noteRecordStop", ...change });
      }
      const recorder = await ctx.services.ui("note.recorder", { action: act });
      return output(await recorderText(ctx, recorder), recorder);
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector as string);
    // The microphone: the user's to allow, each time.
    await ctx.services.askUser({
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId: workspace.id,
      change: {
        kind: "noteRecord",
        detail: note.title || note.id,
        ...(participants !== undefined ? { body: `Participants: ${participants}` } : {}),
      },
    });
    const recorder = await ctx.services.ui(
      "note.recorder",
      {
        action: "start",
        workspaceId: workspace.id,
        noteId: note.id,
        ...(participants !== undefined ? { participants } : {}),
      },
      RECORD_START_MS,
    );
    return output(await recorderText(ctx, recorder), recorder);
  },
};

/** How long a recording may take to start: the microphone, maybe macOS asking for it, the server. */
const RECORD_START_MS = 90_000;

export const noteCommands: CliCommand[] = [
  list,
  read,
  noteTranscript,
  notePath,
  noteNew,
  noteShow,
  noteWrite,
  noteAdd,
  noteRecord,
];
