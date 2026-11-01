/** nexus open, diff, reveal and problems. */
import type { CliProblem } from "../../../../shared/cli/ui";
import { exactArgs } from "../args";
import { CliError, mayChange, placementFor, resolveWorkspace, shortId } from "../context";
import { rendererRoot, splitLocation, workspaceFile } from "../paths";
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
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const { file, line, column } = splitLocation(input);
    const { relPath, filePath } = workspaceFile(ctx, workspace, file);
    const kind = await ctx.services.stat(workspace.id, relPath);
    if (kind === null) throw new CliError(`no such file: ${relPath}`);
    if (kind === "dir") throw new CliError(`${relPath} is a folder`);
    await mayChange(ctx, workspace, { kind: "open", detail: relPath });
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
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const { relPath } = workspaceFile(ctx, workspace, input);
    const base = (flags.base as string | undefined) ?? "HEAD";
    if (base.trim() === "") throw new CliError("--base takes a ref", 2);
    const rightRef = flags.staged === true ? "INDEX" : "WORKING";
    await mayChange(ctx, workspace, { kind: "diff", detail: relPath });
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

const reveal: CliCommand = {
  path: ["reveal"],
  summary: "Show a file or folder in the files panel's tree",
  args: "<path>",
  details:
    "Unfolds the folders above it and selects it, showing the files panel if hidden. The\n" +
    "path is relative to this terminal's directory.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "path") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const { relPath, filePath } = workspaceFile(ctx, workspace, input);
    if ((await ctx.services.stat(workspace.id, relPath)) === null) {
      throw new CliError(`no such file or folder: ${relPath}`);
    }
    await ctx.services.ui("files.reveal", { workspaceId: workspace.id, filePath });
    const shown = ctx.services.shownTab()?.workspaceId === workspace.id;
    return output(
      `Revealed ${relPath} in ${workspace.name}'s files panel${shown ? "" : ", seen once it is shown"}.`,
      { workspaceId: workspace.id, relPath },
    );
  },
};

const RANK: Record<CliProblem["severity"], number> = { error: 0, warning: 1, info: 2, hint: 3 };

const problems: CliCommand = {
  path: ["problems"],
  summary: "List the errors and warnings language servers report in open files",
  details:
    "Only files open in the editor are checked, as the app's problem counts are; run the\n" +
    "project's own checks for the rest.",
  flags: {
    errors: { type: "boolean", description: "Only errors" },
    all: { type: "boolean", description: "Infos and hints too" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const worst = flags.errors === true ? 0 : flags.all === true ? 3 : 1;
    const found = (
      await ctx.services.ui("problems.list", { workspaceId: workspace.id })
    ).problems.filter((p) => RANK[p.severity] <= worst);
    const root = rendererRoot(workspace);
    const rel = (file: string) =>
      file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    const lines = found.map((p) => {
      const from = [p.source, p.code].filter(Boolean).join(" ");
      return `${rel(p.filePath)}:${p.line}:${p.column}  ${p.severity.padEnd(7)}  ${p.message.replace(/\s+/g, " ")}${from ? `  (${from})` : ""}`;
    });
    const count = (severity: CliProblem["severity"]) =>
      found.filter((p) => p.severity === severity).length;
    const errors = count("error");
    const warnings = count("warning");
    const summary =
      found.length === 0
        ? "No problems in the files open in the editor."
        : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in the files open in the editor.`;
    return output([...lines, summary].join("\n"), {
      workspaceId: workspace.id,
      problems: found.map((p) => ({ ...p, relPath: rel(p.filePath) })),
    });
  },
};

export const editorCommands: CliCommand[] = [open, diff, reveal, problems];
