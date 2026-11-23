import type { CliBrowserAction, CliTabInfo } from "../../../../shared/cli/ui";
import { loopbackPort, portUrl } from "../../../../shared/pty/ports";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { shortId } from "../../../../shared/util/short-id";
import { CliUsageError, exactArgs } from "../args";
import type { PageInfo } from "../browser/driver";
import {
  type CliContext,
  CliError,
  mayChange,
  pick,
  placementFor,
  resolveTab,
  resolveWorkspace,
} from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import {
  askPeerCli,
  changePeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerWorkspace,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { BACKGROUND_FLAG, WORKSPACE_FLAG } from "./flags";
import { describePorts, forwardFailed, workspacePorts } from "./port";
import { workspaceTabs } from "./terminal";

const BARE_PATH_DETAILS =
  "A bare path such as /login is on the port the workspace's terminals listen on (nexus\n" +
  "port list), when there is just one; a file is file:///path. In an SSH workspace a\n" +
  "local address is the host's, opened here through its forward (nexus port forward).";

export const TAB_FLAG = {
  type: "string",
  value: "TAB",
  description: "The browser tab; the workspace's only one, or the one shown, by default",
} as const;

async function browserTabs(ctx: CliContext, workspace: WorkspaceMeta): Promise<CliTabInfo[]> {
  return (await workspaceTabs(ctx, workspace.id)).filter((t) => t.type === "browser");
}

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
    `rather than over it. ${BARE_PATH_DETAILS}`,
  flags: { workspace: WORKSPACE_FLAG, background: BACKGROUND_FLAG },
  async run(ctx, { positionals, flags }) {
    const [given] = exactArgs(positionals, "url") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const url = await urlFrom(ctx, workspace, given);
    await mayChange(ctx, workspace, { kind: "browserOpen", detail: url });
    const opened = await ctx.services.ui("browser.open", {
      workspaceId: workspace.id,
      url: await forwardedUrl(ctx, workspace, url),
      placement: placementFor(ctx, workspace, flags.background === true),
    });
    const page = await ctx.services.browser.settle(opened.tabId);
    return output(`${loaded(page, opened.url)} in a new tab, ${shortId(opened.tabId)}.`, {
      tabId: opened.tabId,
      workspaceId: workspace.id,
      url: page?.url ?? opened.url,
    });
  },
};

async function urlFrom(ctx: CliContext, workspace: WorkspaceMeta, given: string): Promise<string> {
  const url = given.trim();
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  return devServerUrl(ctx, workspace, url);
}

async function devServerUrl(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  path: string,
): Promise<string> {
  const ports = await workspacePorts(ctx, workspace);
  const [only] = ports;
  if (!only) {
    throw new CliError(
      `no program in ${workspace.name}'s terminals listens on a port; start its dev server, or give a URL such as localhost:3000${path}`,
    );
  }
  if (ports.length > 1) {
    throw new CliError(
      `${workspace.name}'s terminals listen on several ports, ${describePorts(ports)}; give one, as localhost:${only.port}${path}`,
    );
  }
  return `${portUrl(only.port)}${path}`;
}

async function forwardedUrl(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  url: string,
): Promise<string> {
  if (workspace.location.kind !== "ssh") return url;
  const full = /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`;
  if (loopbackPort(full) === null) return url;
  return ctx.services.forwards.localUrl(workspace.id, full).catch(forwardFailed);
}

function loaded(page: PageInfo | null, asked: string): string {
  if (!page) return `Loading ${asked}`;
  const download = page.download;
  if (download) {
    return `Downloading ${download.url} (${download.type}) to ${download.file} rather than showing it`;
  }
  if (!page.url) return `Nothing loaded from ${asked}`;
  return page.title ? `Loaded ${page.url} "${page.title}"` : `Loaded ${page.url}`;
}

const browserGoto: CliCommand = {
  path: ["browser", "goto"],
  summary: "Load a URL in a browser tab",
  args: "<url>",
  details: BARE_PATH_DETAILS,
  flags: { tab: TAB_FLAG, workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [given] = exactArgs(positionals, "url") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveBrowser(ctx, workspace, flags.tab as string | undefined);
    const url = await urlFrom(ctx, workspace, given);
    await mayChange(ctx, workspace, { kind: "browserNavigate", detail: tab.title });
    const went = await ctx.services.ui("browser.navigate", {
      workspaceId: workspace.id,
      tabId: tab.id,
      action: "goto",
      url: await forwardedUrl(ctx, workspace, url),
    });
    const page = await ctx.services.browser.settle(tab.id);
    return output(`${loaded(page, went.url ?? url)} in ${shortId(tab.id)}.`, {
      tabId: tab.id,
      workspaceId: workspace.id,
      url: page?.url ?? went.url,
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
      const page = await ctx.services.browser.settle(tab.id);
      return output(`${done} in ${shortId(tab.id)}${page ? `; at ${page.url}` : ""}.`, {
        tabId: tab.id,
        workspaceId: workspace.id,
        ...(page ? { url: page.url } : {}),
      });
    },
  };
}

const browserPermissions: CliCommand = {
  path: ["browser", "permissions"],
  summary: "Read global browser permissions and remembered decisions for a workspace",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) requirePeerCli(ctx, device);
    const workspace = device
      ? await peerWorkspace(ctx, device, flags.workspace)
      : resolveWorkspace(ctx, flags.workspace as string | undefined);
    const ref = { workspaceId: workspace.id };
    const result = device
      ? await askPeerCli(ctx, device, "browser.permissions", ref)
      : await ctx.services.ui("browser.permissions", ref);
    const text = table(
      ["SCOPE", "PERMISSION", "DECISION"],
      [
        ...Object.entries(result.global)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, allowed]) => ["global", key, allowed ? "on" : "off"]),
        ...result.sites.map(({ origin, permission, decision }) => [origin, permission, decision]),
      ],
    );
    return output(text || "No saved browser permission settings.", {
      ...ref,
      ...result,
      ...(device ? { device: deviceRef(device) } : {}),
    });
  },
};

const browserDevtools: CliCommand = {
  path: ["browser", "devtools"],
  summary: "Toggle a browser tab's developer tools",
  args: "[tab]",
  flags: { workspace: WORKSPACE_FLAG, device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    if (positionals.length > 1) throw new CliUsageError("give at most one tab");
    const selector = positionals[0];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      requirePeerCli(ctx, device);
      const workspace = await peerWorkspace(ctx, device, flags.workspace);
      const { tabs } = await askPeerCli(ctx, device, "layout.get", { workspaceId: workspace.id });
      const browsers = tabs.filter((tab) => tab.type === "browser");
      const tab =
        selector === undefined
          ? browsers.length === 1
            ? browsers[0]
            : undefined
          : pick(
              browsers,
              selector,
              (tab) => tab.id,
              (tab) => tab.title,
              "browser tab",
            );
      if (!tab) throw new CliError("give a browser tab from layout show");
      const ref = { workspaceId: workspace.id, tabId: tab.id };
      await changePeerCli(ctx, device, "browser.devtools", ref);
      return output(`Toggled developer tools for ${tab.title} on "${device.name}".`, {
        ...ref,
        device: deviceRef(device),
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveBrowser(ctx, workspace, selector);
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    await mayChange(ctx, workspace, {
      kind: "browserControl",
      detail: tab.title,
      body: "Toggle browser developer tools",
    });
    await ctx.services.ui("browser.devtools", ref);
    return output(`Toggled developer tools for ${tab.title}.`, ref);
  },
};

export const browserCommands: CliCommand[] = [
  browserList,
  browserPermissions,
  browserDevtools,
  browserOpen,
  browserGoto,
  historyCommand("back", "Go back in a browser tab"),
  historyCommand("forward", "Go forward in a browser tab"),
  historyCommand("reload", "Reload a browser tab"),
];
