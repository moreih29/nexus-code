/**
 * nexus panel list/show/hide/resize: the two columns left of the editor
 * area, the workspace sidebar and the files panel, and what the files panel
 * shows: the file tree, search or git.
 *
 * The columns are the app's, not a workspace's, so changing them needs no
 * leave; the files panel's view is kept per workspace.
 */
import type { CliFilesMode, CliPanel, CliPanels } from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs } from "../args";
import { resolveWorkspace } from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";

/** A panel as the command line names it: a column, and a view of the files panel. */
const NAMES: Record<string, { panel: CliPanel; mode?: CliFilesMode }> = {
  sidebar: { panel: "sidebar" },
  workspaces: { panel: "sidebar" },
  files: { panel: "files", mode: "tree" },
  tree: { panel: "files", mode: "tree" },
  search: { panel: "files", mode: "search" },
  git: { panel: "files", mode: "git" },
};

const NAMES_HELP =
  "Panels: sidebar (the workspace list) and files, whose views are files (the tree),\n" +
  "search and git.";

function panelNamed(word: string): { panel: CliPanel; mode?: CliFilesMode } {
  const named = NAMES[word.toLowerCase()];
  if (!named)
    throw new CliUsageError(`no panel "${word}"; there are sidebar, files, search and git`);
  return named;
}

function describe(panels: CliPanels): string {
  return table(
    ["PANEL", "", "WIDTH", "VIEW"],
    [
      ["sidebar", panels.sidebar.visible ? "shown" : "hidden", `${panels.sidebar.width}px`, ""],
      [
        "files",
        panels.files.visible ? "shown" : "hidden",
        `${panels.files.width}px`,
        panels.files.mode,
      ],
    ],
  );
}

const panelList: CliCommand = {
  path: ["panel", "list"],
  summary: "Show which panels beside the editor area are shown, and their widths",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const panels = await ctx.services.ui("panels.get", { workspaceId: workspace.id });
    return output(describe(panels), panels);
  },
};

function visibilityCommand(visible: boolean): CliCommand {
  return {
    path: ["panel", visible ? "show" : "hide"],
    summary: visible ? "Show a panel, or a view of the files panel" : "Hide a panel",
    args: "<panel>",
    details: NAMES_HELP,
    flags: { workspace: WORKSPACE_FLAG },
    async run(ctx, { positionals, flags }) {
      const [word] = exactArgs(positionals, "panel") as [string];
      const { panel, mode } = panelNamed(word);
      const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
      const panels = await ctx.services.ui("panels.set", {
        workspaceId: workspace.id,
        panel,
        visible,
        ...(visible && mode ? { mode } : {}),
      });
      return output(
        `${visible ? "Showing" : "Hid"} ${visible ? word.toLowerCase() : panel}.`,
        panels,
      );
    },
  };
}

const panelResize: CliCommand = {
  path: ["panel", "resize"],
  summary: "Set a panel's width in pixels",
  args: "<sidebar|files> <width>",
  details:
    "The app keeps a width within its limits: 180-480px for the sidebar, 160-600px for files.",
  async run(ctx, { positionals }) {
    const [word, widthText] = exactArgs(positionals, "panel", "width") as [string, string];
    const { panel } = panelNamed(word);
    const width = Number(widthText.replace(/px$/i, ""));
    if (!Number.isFinite(width) || width <= 0) {
      throw new CliUsageError(`the width is a number of pixels, not "${widthText}"`);
    }
    const workspace = resolveWorkspace(ctx, undefined);
    const panels = await ctx.services.ui("panels.set", { workspaceId: workspace.id, panel, width });
    return output(`The ${panel} panel is ${panels[panel].width}px wide.`, panels);
  },
};

export const panelCommands: CliCommand[] = [
  panelList,
  visibilityCommand(true),
  visibilityCommand(false),
  panelResize,
];
