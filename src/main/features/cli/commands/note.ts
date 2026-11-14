/** nexus note list|read|path: the workspace's notes, kept by the app. */
import { isManager } from "../../../../shared/manager/manager";
import type { NoteContent, NoteSummary } from "../../../../shared/notes/types";
import { noteMarkdown } from "../../notes/store";
import { exactArgs } from "../args";
import { type CliContext, CliError, pick, resolveWorkspace } from "../context";
import { ago, oneLine, table } from "../format";

import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";

/** When a note was last written: how long ago within two days, else its date. */
function when(at: number, now: number): string {
  if (now - at < 48 * 3600 * 1000) return ago(at, now);
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Whether the command runs in a terminal on the machine the app runs on (a
 * local workspace's, or the agent manager's), where the notes' folders are.
 */
function onAppMachine(ctx: CliContext): boolean {
  if (isManager(ctx.caller)) return true;
  const own = ctx.services.listWorkspaces().find((w) => w.id === ctx.caller.workspaceId);
  return own?.location.kind === "local";
}

const NOTE_ARG_HELP =
  "A note is named by its id, an id prefix, or its title (as nexus note list shows them).";

/** What a note has in it, in a few words. */
export function contentsOf(note: Pick<NoteSummary, "counts">): string {
  const { sketches, files, images, todos, todosDone } = note.counts;
  const parts: string[] = [];
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

const list: CliCommand = {
  path: ["note", "list"],
  summary: "List the workspace's notes, newest first",
  details:
    "Notes are kept by the app (not in the workspace's folder), by where the workspace's\n" +
    "folder is. Read one with nexus note read.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
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
    "path is printed after it, and nexus note path prints it alone.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "note");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const note = await findNote(ctx, workspace.id, selector as string);
    const markdown = noteMarkdown(note);
    const local = onAppMachine(ctx);
    const { sketches, files, images } = note.counts;
    const footer =
      local && sketches + files + images > 0 ? `\n<!-- The note's files: ${note.dir} -->\n` : "";
    return output(`${markdown || "(empty note)\n"}${footer}`.replace(/\n$/, ""), {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
      markdown,
      ...(local ? { dir: note.dir } : {}),
    });
  },
};

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

export const noteCommands: CliCommand[] = [list, read, notePath];
