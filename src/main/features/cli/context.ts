/**
 * What a nexus command runs with: who asked, what the app can tell it, and
 * how it names workspaces and tabs on the command line.
 */
import type { RpcMethod, RpcParams, RpcResult } from "../../../../packages/remote-protocol/src";
import type { AgentRun, PermissionAnswer, PermissionAsk } from "../../../shared/claude/activity";
import type { ClaudeStatus } from "../../../shared/claude/status";
import type { CliInvocation } from "../../../shared/cli/protocol";
import type {
  CliChange,
  CliPlacement,
  CliTabInfo,
  CliUiOp,
  CliUiOps,
} from "../../../shared/cli/ui";
import type { FsEntryType } from "../../../shared/fs/types";
import { isManager, type ManagerPermissions } from "../../../shared/manager/manager";
import type { ListeningPort, PortForward } from "../../../shared/pty/ports";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import type { TabActivity } from "./activity";
import type { BrowserDriver } from "./browser/driver";
import type { ChangeRequest } from "./consent";
import type { AgentInputs } from "./hops";
import type { StartedAgents } from "./started-agents";
import type { WaitRegistry } from "./waits";

/** A failure the command reports as is, with its exit code; with --json, `json` too. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly json?: unknown,
  ) {
    super(message);
  }
}

/** A device of the user's account, as `nexus device list` shows it. */
export interface CliDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  /** Whether it is this computer. */
  readonly self: boolean;
  readonly online: boolean;
  /** When the server last heard from it, in Unix ms. */
  readonly lastSeen?: number;
  /** What it serves its account's other devices, as its hello said; none until it said one. */
  readonly serves: readonly string[];
  /** The protocol package's version it speaks; absent from an older NexusCode. */
  readonly schema?: string;
}

/** The user's other computers, through the remote's room, for `--device`. */
export interface CliRemote {
  /** Whether this computer is in its account's room now: signed in, its key unlocked, connected. */
  inRoom(): boolean;
  /** The account's devices, as the server and the room know them; the room's alone without the server. */
  devices(): Promise<CliDevice[]>;
  /** Asks another device; a RpcFailure for its refusal or its silence. */
  request<M extends RpcMethod>(
    deviceId: string,
    method: M,
    params: RpcParams<M>,
    timeoutMs?: number,
  ): Promise<RpcResult<M>>;
}

/** A consent prompt waiting on the user (consent-prompts.ts). */
export interface PendingConsent {
  readonly id: string;
  /** When it was asked, and when it counts as turned down (Unix ms). */
  readonly at: number;
  readonly expiresAt: number;
  /** What was asked, as the renderer shows it. */
  readonly request: CliUiOps["consent.ask"]["args"];
}

/** The consent prompts waiting on the user, for another device of theirs to list and answer. */
export interface CliConsents {
  /** In the order asked. */
  list(): readonly PendingConsent[];
  /**
   * Answers one as the user would, from the device named `by`; false when
   * it no longer waits.
   */
  answer(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean>;
}

/** The app as the commands see it. */
export interface CliServices {
  /** The consent prompts waiting on the user. */
  readonly consents: CliConsents;
  /** The user's other computers, for --device. */
  readonly remote: CliRemote;
  readonly appVersion: string;
  listWorkspaces(): WorkspaceMeta[];
  /**
   * Adds a workspace to the app's list, as Add Workspace does, connected
   * once it is first shown; the one already listed at `location` if any,
   * with `added` false. A CliError when a local folder is not there.
   */
  addWorkspace(
    location: WorkspaceLocation,
    name: string | undefined,
  ): Promise<{ workspace: WorkspaceMeta; added: boolean }>;
  /** The workspace and tab the user is looking at, if the app has focus or not. */
  shownTab(): { workspaceId: string; tabId: string } | null;
  /**
   * Claude Code's state from its hooks: `since` when the status last changed,
   * `turnStartedAt` when it last started working.
   */
  claudeStatus(
    workspaceId: string,
    tabId: string,
  ): { status: ClaudeStatus; message?: string; since: number; turnStartedAt?: number } | null;
  activity(workspaceId: string, tabId: string): TabActivity | null;
  /** The permission requests a terminal's Claude Code holds for the app to answer, oldest first. */
  claudeAsks(workspaceId: string, tabId: string): readonly PermissionAsk[];
  /**
   * Answers a request a terminal's Claude Code holds, as the app's card
   * does: false when it no longer waits, or cannot be answered so.
   */
  answerClaudeAsk(
    workspaceId: string,
    tabId: string,
    askId: string,
    answer: PermissionAnswer,
  ): Promise<boolean>;
  /** The agent manager's own workspace, once the manager opened it; listWorkspaces leaves it out. */
  managerWorkspace(): WorkspaceMeta | null;
  /** The subagents and `claude -p` runs of the Claude sessions in the terminals. */
  readonly claudeAgents: CliClaudeAgents;
  /** Lists a wait on a terminal until the returned function is called. */
  readonly waits: Pick<WaitRegistry, "begin">;
  /** The agents' input into terminals, for how far down a chain of agents' messages they are. */
  readonly agentInputs: AgentInputs;
  /**
   * Asks the renderer, which owns the tabs and the terminals' screens; a
   * longer `timeoutMs` for an answer that waits on git.
   */
  ui<K extends CliUiOp>(
    op: K,
    args: CliUiOps[K]["args"],
    timeoutMs?: number,
  ): Promise<CliUiOps[K]["result"]>;
  /** Tells the user, as Claude's notifications do, unless they are looking at the tab. */
  notify(workspaceId: string, tabId: string, title: string, body: string): boolean;
  /** What is at `relPath` in a workspace; null when nothing is. */
  stat(workspaceId: string, relPath: string): Promise<FsEntryType | null>;
  /**
   * Resolves when a change to another workspace than the caller's may go
   * ahead, as the setting or the user says; a CliError saying why when not.
   */
  allowChange(request: ChangeRequest): Promise<void>;
  /**
   * Resolves when the user allows `request`, asked whatever the setting;
   * a CliError saying why when not.
   */
  askUser(request: ChangeRequest): Promise<void>;
  /** What the agent manager may do with another session's permission request. */
  managerPermissions(): ManagerPermissions;
  /** Whether Claude Code sessions are to be told about nexus when they start. */
  agentContextEnabled(): boolean;
  /** The program holding a terminal's foreground; null when the agent cannot tell. */
  foregroundProcess(workspaceId: string, tabId: string): Promise<string | null>;
  /**
   * The TCP ports the programs in a workspace's terminals listen on, looked
   * at now, in port order.
   */
  listeningPorts(workspaceId: string): Promise<readonly ListeningPort[]>;
  /** The SSH workspaces' ports forwarded to this machine. */
  readonly forwards: CliForwards;
  /**
   * Terminals whose agent nexus worktree new just started with a prompt, so
   * that a wait on one holds until the agent has begun its first turn.
   */
  readonly startedAgents: Pick<StartedAgents, "mark" | "since">;
  /** Time, for commands that wait. */
  readonly clock: { now(): number; sleep(ms: number): Promise<void> };
  /** Reads and drives the pages of browser tabs. */
  readonly browser: BrowserDriver;
}

export interface CliContext {
  /** The terminal the command runs in. */
  readonly caller: { readonly workspaceId: string; readonly tabId: string };
  readonly invocation: CliInvocation;
  readonly services: CliServices;
  /** Aborted when the command's client has gone, as one stopped with Ctrl-C. */
  readonly signal?: AbortSignal;
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
 * out or is "." . The agent manager is in none of the user's: for it, the
 * one the user is looking at.
 */
export function resolveWorkspace(ctx: CliContext, selector: string | undefined): WorkspaceMeta {
  const workspaces = ctx.services.listWorkspaces();
  const own = selector === undefined || selector === ".";
  if (own && isManager(ctx.caller)) {
    const shown = ctx.services.shownTab()?.workspaceId;
    const workspace = workspaces.find((w) => w.id === shown);
    if (workspace) return workspace;
    throw new CliError("you are the agent manager, in no workspace: give --workspace");
  }
  const target = own ? ctx.caller.workspaceId : selector;
  return pick(
    workspaces,
    target,
    (w) => w.id,
    (w) => w.name,
    "workspace",
  );
}

/**
 * Lets a command make `change` in `workspace`: always in the caller's own,
 * in another as the setting or the user allows. Throws a CliError if not.
 */
export async function mayChange(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  change: CliChange,
): Promise<void> {
  if (workspace.id === ctx.caller.workspaceId) return;
  // The user turned the manager on to direct every workspace.
  if (isManager(ctx.caller)) return;
  await ctx.services.allowChange({
    fromWorkspaceId: ctx.caller.workspaceId,
    fromTabId: ctx.caller.tabId,
    toWorkspaceId: workspace.id,
    change,
  });
}

/** The agents of a terminal's Claude session (claude/session-activity.ts). */
export interface CliClaudeAgents {
  /** Running ones, then ended ones, latest first; none when the terminal runs no session. */
  list(workspaceId: string, tabId: string): readonly AgentRun[];
  /**
   * Stops a running `claude -p` run, as an interrupt would; false when the
   * app holds no watch of it to tell.
   */
  stop(workspaceId: string, tabId: string, agentId: string): Promise<boolean>;
}

/** An SSH workspace's ports forwarded to this machine (pty/forwards.ts). */
export interface CliForwards {
  list(workspaceId: string): readonly PortForward[];
  /** Fails with a ForwardError when the workspace is not connected or ssh fails. */
  forward(workspaceId: string, port: number): Promise<PortForward>;
  stop(workspaceId: string, port: number): Promise<void>;
  /** The URL to open here for `url`: a local address goes to its forward. */
  localUrl(workspaceId: string, url: string): Promise<string>;
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
  if (location.kind === "wsl") return `WSL ${location.distro}:${location.remotePath}`;
  const user = location.user ? `${location.user}@` : "";
  return `${user}${location.host}:${location.remotePath}`;
}

/**
 * Tells the app that the agent manager handed work to a session, sending it
 * `text` when it did, so that the session counts as its task. Nothing for
 * another caller; the work went out whether or not the app hears of it.
 */
export async function noteDispatch(
  ctx: CliContext,
  target: { readonly workspaceId: string; readonly tabId: string },
  text?: string,
): Promise<void> {
  if (!isManager(ctx.caller)) return;
  try {
    await ctx.services.ui("manager.dispatched", {
      workspaceId: target.workspaceId,
      tabId: target.tabId,
      ...(text ? { text } : {}),
    });
  } catch {
    // Its tracking only: the session has the work.
  }
}
