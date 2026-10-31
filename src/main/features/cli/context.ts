/**
 * What a nexus command runs with: who asked, what the app can tell it, and
 * how it names workspaces and tabs on the command line.
 */
import type { ClaudeStatus } from "../../../shared/claude/status";
import type { CliInvocation } from "../../../shared/cli/protocol";
import type { CliPlacement, CliTabInfo, CliUiOp, CliUiOps } from "../../../shared/cli/ui";
import type { FsEntryType } from "../../../shared/fs/types";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { TabActivity } from "./activity";

/** A failure the command reports as is, with its exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** The app as the commands see it. */
export interface CliServices {
  readonly appVersion: string;
  listWorkspaces(): WorkspaceMeta[];
  /** The workspace and tab the user is looking at, if the app has focus or not. */
  shownTab(): { workspaceId: string; tabId: string } | null;
  claudeStatus(
    workspaceId: string,
    tabId: string,
  ): { status: ClaudeStatus; message?: string; since: number } | null;
  activity(workspaceId: string, tabId: string): TabActivity | null;
  /** Asks the renderer, which owns the tabs and the terminals' screens. */
  ui<K extends CliUiOp>(op: K, args: CliUiOps[K]["args"]): Promise<CliUiOps[K]["result"]>;
  /** Tells the user, as Claude's notifications do, unless they are looking at the tab. */
  notify(workspaceId: string, tabId: string, title: string, body: string): boolean;
  /** What is at `relPath` in a workspace; null when nothing is. */
  stat(workspaceId: string, relPath: string): Promise<FsEntryType | null>;
}

export interface CliContext {
  /** The terminal the command runs in. */
  readonly caller: { readonly workspaceId: string; readonly tabId: string };
  readonly invocation: CliInvocation;
  readonly services: CliServices;
}

/** Ids are shown this long; any unique prefix of at least MIN_PREFIX is taken. */
export const SHORT_ID_LENGTH = 8;
const MIN_PREFIX = 4;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/**
 * Finds the one item a selector names: by id, by an id prefix, then by
 * name, case aside. None or several is a CliError.
 */
export function pick<T>(
  items: readonly T[],
  selector: string,
  id: (item: T) => string,
  name: (item: T) => string,
  what: string,
): T {
  const exact = items.find((item) => id(item) === selector);
  if (exact) return exact;
  const lower = selector.toLowerCase();
  const byPrefix =
    selector.length >= MIN_PREFIX ? items.filter((item) => id(item).startsWith(lower)) : [];
  if (byPrefix.length === 1) return byPrefix[0] as T;
  const byName = items.filter((item) => name(item).toLowerCase() === lower);
  if (byName.length === 1) return byName[0] as T;
  const matches = byPrefix.length > 1 ? byPrefix : byName;
  if (matches.length > 1) {
    const listed = matches.map((item) => `${shortId(id(item))} ${name(item)}`).join(", ");
    throw new CliError(`"${selector}" matches more than one ${what}: ${listed}`);
  }
  throw new CliError(`no ${what} "${selector}"`);
}

/**
 * The workspace a --workspace flag names; the caller's own when it is left
 * out or is "." .
 */
export function resolveWorkspace(ctx: CliContext, selector: string | undefined): WorkspaceMeta {
  const workspaces = ctx.services.listWorkspaces();
  const target = selector === undefined || selector === "." ? ctx.caller.workspaceId : selector;
  return pick(
    workspaces,
    target,
    (w) => w.id,
    (w) => w.name,
    "workspace",
  );
}

/**
 * The workspace a command that changes things acts on, named as for
 * resolveWorkspace. Only the caller's own for now: changing another one needs
 * the user's consent, which the app does not ask for yet.
 */
export async function writableWorkspace(
  ctx: CliContext,
  selector: string | undefined,
): Promise<WorkspaceMeta> {
  const workspace = resolveWorkspace(ctx, selector);
  if (workspace.id !== ctx.caller.workspaceId) {
    throw new CliError(
      `${workspace.name} is another workspace; nexus changes only this terminal's workspace`,
    );
  }
  return workspace;
}

/** Where a tab the command opens in `workspace` goes: beside the caller in its own. */
export function placementFor(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  background: boolean,
): CliPlacement {
  return workspace.id === ctx.caller.workspaceId
    ? { background, besideTabId: ctx.caller.tabId }
    : { background };
}

/** The tab a selector names among `tabs`; "." is the caller's own terminal. */
export function resolveTab(
  ctx: CliContext,
  tabs: readonly CliTabInfo[],
  selector: string,
  what = "tab",
): CliTabInfo {
  const target = selector === "." ? ctx.caller.tabId : selector;
  return pick(
    tabs,
    target,
    (t) => t.id,
    (t) => t.title,
    what,
  );
}

/** A workspace's place, as a person would write it. */
export function describeLocation(workspace: WorkspaceMeta): string {
  const location = workspace.location;
  if (location.kind === "local") return location.rootPath;
  if (location.kind === "wsl") return `wsl:${location.distro}:${location.remotePath}`;
  const user = location.user ? `${location.user}@` : "";
  return `${user}${location.host}:${location.remotePath}`;
}
