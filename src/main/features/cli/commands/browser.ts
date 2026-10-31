/** nexus browser list/open/goto/back/forward/reload. */
import type { CliBrowserAction, CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { exactArgs } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
  placementFor,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import { BACKGROUND_FLAG, WORKSPACE_FLAG } from "./flags";
import { workspaceTabs } from "./terminal";

const TAB_FLAG = {
  type: "string",
  value: "TAB",
  description: "The browser tab; the workspace's only one, or the one shown, by default",
} as const;

async function browserTabs(ctx: CliContext, workspace: WorkspaceMeta): Promise<CliTabInfo[]> {
  return (await workspaceTabs(ctx, workspace.id)).filter((t) => t.type === "browser");
}

/**
 * The browser tab --tab names, or without it the workspace's only one, or
 * else the only one a group shows.
 */
export async function resolveBrowser(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  selector: string | undefined,
): Promise<CliTabInfo> {
  const tabs = await browserTabs(ctx, workspace);
  if (selector !== undefined) {
    return resolveTab(ctx, tabs, selector, `browser tab in ${workspace.name}`);
  }
  if (tabs.length === 0) {
    throw new CliError(`${workspace.name} has no browser tab; open one with "nexus browser open"`);
  }
  if (tabs.length === 1) return tabs[0] as CliTabInfo;
  const shown = tabs.filter((t) => t.shown);
  if (shown.length === 1) return shown[0] as CliTabInfo;
  const listed = tabs.map((t) => `${shortId(t.id)} ${t.url ?? t.title}`).join(", ");
  throw new CliError(`${workspace.name} has several browser tabs; pick one with --tab: ${listed}`);
}

const browserList: CliCommand = {
  path: ["browser", "list"],
  summary: "List a workspace's browser tabs",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { flags }) {
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tabs = await browserTabs(ctx, workspace);
    const rows = tabs.map((t) => [shortId(t.id), t.title, t.url ?? "", t.shown ? "shown" : ""]);
    return output(
      tabs.length
        ? table(["ID", "TITLE", "URL", ""], rows)
        : `${workspace.name} has no browser tab.`,
      tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, shown: t.shown })),
    );
  },
};

const browserOpen: CliCommand = {
  path: ["browser", "open"],
  summary: "Open a URL in a new browser tab",
  args: "<url>",
  details:
    "Takes a URL or an address such as localhost:3000. The tab opens beside this terminal\n" +
    "rather than over it.",
  flags: { workspace: WORKSPACE_FLAG, background: BACKGROUND_FLAG },
  async run(ctx, { positionals, flags }) {
    const [url] = exactArgs(positionals, "url") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    await mayChange(ctx, workspace, { kind: "browserOpen", detail: url });
    const opened = await ctx.services.ui("browser.open", {
      workspaceId: workspace.id,
      url,
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    return output(`Opened ${opened.url} (tab ${shortId(opened.tabId)}).`, {
      tabId: opened.tabId,
      workspaceId: workspace.id,
      url: opened.url,
    });
  },
};

const browserGoto: CliCommand = {
  path: ["browser", "goto"],
  summary: "Load a URL in a browser tab",
  args: "<url>",
  flags: { tab: TAB_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [url] = exactArgs(positionals, "url") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveBrowser(ctx, workspace, flags.tab as string | undefined);
    await mayChange(ctx, workspace, { kind: "browserNavigate", detail: tab.title });
    const went = await ctx.services.ui("browser.navigate", {
      workspaceId: workspace.id,
      tabId: tab.id,
      action: "goto",
      url,
    });
    return output(`Loading ${went.url ?? url} in ${shortId(tab.id)}.`, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: went.url,
    });
  },
};

function historyCommand(action: Exclude<CliBrowserAction, "goto">, summary: string): CliCommand {
  return {
    path: ["browser", action],
    summary,
    flags: { tab: TAB_FLAG, workspace: WORKSPACE_FLAG },
    async run(ctx, { positionals, flags }) {
      exactArgs(positionals);
      const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
      const tab = await resolveBrowser(ctx, workspace, flags.tab as string | undefined);
      await mayChange(ctx, workspace, { kind: "browserNavigate", detail: tab.title });
      await ctx.services.ui("browser.navigate", {
        workspaceId: workspace.id,
        tabId: tab.id,
        action,
      });
      const done = { back: "Went back", forward: "Went forward", reload: "Reloaded" }[action];
      return output(`${done} in ${shortId(tab.id)}.`, { tabId: tab.id, workspaceId: workspace.id });
    },
  };
}

export const browserCommands: CliCommand[] = [
  browserList,
  browserOpen,
  browserGoto,
  historyCommand("back", "Go back in a browser tab"),
  historyCommand("forward", "Go forward in a browser tab"),
  historyCommand("reload", "Reload a browser tab"),
];
