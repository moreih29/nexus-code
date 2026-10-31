/** nexus open and nexus diff. */
import { exactArgs } from "../args";
import { CliError, placementFor, shortId, writableWorkspace } from "../context";
import { splitLocation, workspaceFile } from "../paths";
import { type CliCommand, output } from "../registry";
import { BACKGROUND_FLAG, WORKSPACE_FLAG } from "./flags";

const PLACEMENT_DETAILS =
  "It opens beside this terminal rather than over it, and the keyboard stays here.";

const open: CliCommand = {
  path: ["open"],
  summary: "Open a file in the editor, at a line if given",
  args: "<file>[:line[:column]]",
  details: `The file is relative to this terminal's directory. ${PLACEMENT_DETAILS}`,
  flags: { workspace: WORKSPACE_FLAG, background: BACKGROUND_FLAG },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "file") as [string];
    const workspace = await writableWorkspace(ctx, flags.workspace as string | undefined);
    const { file, line, column } = splitLocation(input);
    const { relPath, filePath } = workspaceFile(ctx, workspace, file);
    const kind = await ctx.services.stat(workspace.id, relPath);
    if (kind === null) throw new CliError(`no such file: ${relPath}`);
    if (kind === "dir") throw new CliError(`${relPath} is a folder`);
    const { tabId } = await ctx.services.ui("editor.open", {
      workspaceId: workspace.id,
      filePath,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    const at = line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`;
    return output(`Opened ${relPath}${at} (tab ${shortId(tabId)}).`, {
      tabId,
      workspaceId: workspace.id,
      path: relPath,
      line,
      column,
    });
  },
};

const diff: CliCommand = {
  path: ["diff"],
  summary: "Open a file's changes in a diff tab",
  args: "<file>",
  details:
    "Shows the working tree against HEAD by default. The file is relative to this terminal's\n" +
    `directory. ${PLACEMENT_DETAILS}`,
  flags: {
    staged: { type: "boolean", description: "The staged changes: the index against the base" },
    base: {
      type: "string",
      value: "REF",
      description: "Compare against REF (a branch, tag or commit) instead of HEAD",
    },
    workspace: WORKSPACE_FLAG,
    background: BACKGROUND_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "file") as [string];
    const workspace = await writableWorkspace(ctx, flags.workspace as string | undefined);
    const { relPath } = workspaceFile(ctx, workspace, input);
    const base = (flags.base as string | undefined) ?? "HEAD";
    if (base.trim() === "") throw new CliError("--base takes a ref", 2);
    const rightRef = flags.staged === true ? "INDEX" : "WORKING";
    const { tabId } = await ctx.services.ui("diff.open", {
      workspaceId: workspace.id,
      relPath,
      leftRef: base,
      rightRef,
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    const right = rightRef === "INDEX" ? "index" : "working tree";
    return output(
      `Opened the diff of ${relPath}, ${base} against the ${right} (tab ${shortId(tabId)}).`,
      {
        tabId,
        workspaceId: workspace.id,
        path: relPath,
        base,
        against: rightRef === "INDEX" ? "index" : "working",
      },
    );
  },
};

export const editorCommands: CliCommand[] = [open, diff];
