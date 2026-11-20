/** nexus open, diff, show, reveal and problems. */
import type { CliEditorView, CliProblem } from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs } from "../args";
import { CliError, mayChange, placementFor, resolveWorkspace, shortId } from "../context";
import { rendererRoot, splitLocation, workspaceFile } from "../paths";
import { type CliCommand, output } from "../registry";
import { BACKGROUND_FLAG, WORKSPACE_FLAG } from "./flags";
import { resolveAnyTab } from "./terminal";

const PLACEMENT_DETAILS =
  "It opens beside this terminal rather than over it, and the keyboard stays here.";

/** The view open --preview or --source asks for; none when neither. */
function viewFlag(flags: Record<string, unknown>): CliEditorView | undefined {
  if (flags.preview === true && flags.source === true) {
    throw new CliUsageError("--preview and --source do not go together");
  }
  return flags.preview === true ? "preview" : flags.source === true ? "source" : undefined;
}

const open: CliCommand = {
  path: ["open"],
  summary: "Open a file in the editor, at a line if given",
  args: "<file>[:line[:column]]",
  details:
    "The file is relative to this terminal's directory. A file with a preview (Markdown, HTML,\n" +
    "SVG, CSV, JSON, YAML, notebooks) opens as Settings › Editor says, unless --preview or\n" +
    `--source; a line opens its source.\n${PLACEMENT_DETAILS}`,
  flags: {
    preview: { type: "boolean", description: "Show its preview, this time" },
    source: { type: "boolean", description: "Show its source, this time" },
    workspace: WORKSPACE_FLAG,
    background: BACKGROUND_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "file") as [string];
    const view = viewFlag(flags);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const { file, line, column } = splitLocation(input);
    if (line !== undefined && view === "preview") {
      throw new CliUsageError("a line is in the source; leave out --preview");
    }
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
      ...(view === undefined ? {} : { view }),
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    const at = line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`;
    const shows = view === undefined ? "" : `, its ${view}`;
    return output(`Opened ${relPath}${at}${shows} (tab ${shortId(tabId)}).`, {
      tabId,
      workspaceId: workspace.id,
      path: relPath,
      line,
      column,
      ...(view === undefined ? {} : { view }),
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

const show: CliCommand = {
  path: ["show"],
  summary: "Open a commit in a tab: its message and the files it changed",
  args: "[commit]",
  details:
    "COMMIT is a sha or the start of one, a branch, a tag or HEAD~2; HEAD by default. A\n" +
    `file the tab lists opens its diff. ${PLACEMENT_DETAILS}`,
  flags: { workspace: WORKSPACE_FLAG, background: BACKGROUND_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 1) {
      throw new CliUsageError(`unexpected argument "${positionals[1]}"`);
    }
    const rev = (positionals[0] ?? "HEAD").trim();
    // git would read it as one of its options.
    if (rev === "" || rev.startsWith("-")) throw new CliError(`no commit is named "${rev}"`, 2);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    await mayChange(ctx, workspace, { kind: "commit", detail: rev });
    const { tabId, sha, subject } = await ctx.services.ui("commit.open", {
      workspaceId: workspace.id,
      rev,
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    return output(`Opened commit ${sha.slice(0, 7)} "${subject}" (tab ${shortId(tabId)}).`, {
      tabId,
      workspaceId: workspace.id,
      sha,
      subject,
    });
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

const newEditor: CliCommand = {
  path: ["tab", "new-editor"],
  summary: "Open an untitled editor buffer",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    await mayChange(ctx, workspace, { kind: "open", detail: "untitled editor" });
    const { tabId } = await ctx.services.ui("editor.newUntitled", { workspaceId: workspace.id });
    return output(`Opened untitled editor ${shortId(tabId)}.`, {
      workspaceId: workspace.id,
      tabId,
    });
  },
};

const tabEncoding: CliCommand = {
  path: ["tab", "encoding"],
  args: "<tab>",
  summary: "Read a file tab's encoding, or reopen or save it in another encoding",
  flags: {
    reopen: { type: "string", value: "ID", description: "Reopen the file with that encoding" },
    "save-as": { type: "string", value: "ID", description: "Write the file using that encoding" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const reopen = flags.reopen as string | undefined;
    const saveAs = flags["save-as"] as string | undefined;
    if (reopen !== undefined && saveAs !== undefined)
      throw new CliUsageError("give --reopen or --save-as");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    if (reopen !== undefined || saveAs !== undefined)
      await mayChange(ctx, workspace, {
        kind: reopen !== undefined ? "open" : "tabSave",
        detail: tab.title,
      });
    const result = await ctx.services.ui("editor.encoding", {
      workspaceId: workspace.id,
      tabId: tab.id,
      reopen,
      saveAs,
    });
    const choices = result.choices.map(({ id, name }) => `${id}: ${name}`);
    return output([`${tab.title}: ${result.encoding}`, ...choices].join("\n"), result);
  },
};

export const editorCommands: CliCommand[] = [
  open,
  diff,
  show,
  reveal,
  problems,
  newEditor,
  tabEncoding,
];
