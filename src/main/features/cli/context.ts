import type { RpcMethod, RpcParams, RpcResult } from "../../../../packages/remote-protocol/src";
import type { AgentRun, PermissionAnswer, PermissionAsk } from "../../../shared/claude/activity";
import type { ClaudeStatus } from "../../../shared/claude/status";
import type { CliInvocation } from "../../../shared/cli/protocol";
import type {
  CliChange,
  CliConsentAnswer,
  CliPlacement,
  CliTabInfo,
  CliUiOp,
  CliUiOps,
} from "../../../shared/cli/ui";
import type { FsEntryType } from "../../../shared/fs/types";
import type { LineReport } from "../../../shared/notes/line-report";
import type { NoteConversation } from "../../../shared/notes/links";
import type { DocNode } from "../../../shared/notes/markdown";
import type { TranscriptFile } from "../../../shared/notes/transcript";
import type { NoteAsset, NoteContent, NoteSummary } from "../../../shared/notes/types";
import type { ListeningPort, PortForward } from "../../../shared/pty/ports";
import type { LinkedNote } from "../../../shared/types/notes";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import type { WorkspaceColor } from "../../../shared/types/workspace-color";
import { shortId } from "../../../shared/util/short-id";
import type { ProfileConnections } from "../agent-profiles/connection-save";
import type { ClaudeInstructionHook } from "../chat/instructions";
import type { TabActivity } from "./activity";
import type { BrowserDriver } from "./browser/driver";
import type { ChangeRequest } from "./consent";
import type { StartedAgents } from "./started-agents";
import type { WaitRegistry } from "./waits";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly json?: unknown,
  ) {
    super(message);
  }
}

export interface CliDevice {
  readonly id: string;
  readonly name: string;
  readonly hostName?: string;
  readonly platform: string;
  readonly self: boolean;
  readonly online: boolean;
  readonly lastSeen?: number;
  readonly serves: readonly string[];
  readonly schema?: string;
}

export interface CliRemote {
  inRoom(): boolean;
  devices(): Promise<CliDevice[]>;
  alias?(deviceId: string, alias: string | null): Promise<void>;
  request<M extends RpcMethod>(
    deviceId: string,
    method: M,
    params: RpcParams<M>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>>;
}

export interface PendingConsent {
  readonly id: string;
  readonly at: number;
  readonly expiresAt?: number;
  readonly request: CliUiOps["consent.ask"]["args"];
}

export interface CliConsents {
  ask(
    args: CliUiOps["consent.ask"]["args"],
    bridgeTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ answer: CliConsentAnswer }>;
  list(): readonly PendingConsent[];
  answer(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean>;
}

export interface WorkspaceMove {
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly group: "pinned" | "unpinned";
}

export interface SessionsRenderer {
  readonly latest: number | undefined;
  readonly closed: boolean;
  saw(revision: number): void;
  snapshot(
    args: CliUiOps["sessions.snapshot"]["args"],
    timeoutMs: number,
  ): Promise<CliUiOps["sessions.snapshot"]["result"]>;
}

export interface SessionsRevision {
  current(): SessionsRenderer | undefined;
}

export interface CliServices {
  readonly consents: CliConsents;
  readonly sessionsRevision?: SessionsRevision;
  readonly remote: CliRemote;
  readonly appVersion: string;
  readonly profileConnections: ProfileConnections;
  listWorkspaces(): WorkspaceMeta[];
  addWorkspace(
    location: WorkspaceLocation,
    name: string | undefined,
    color?: WorkspaceColor,
  ): Promise<{ workspace: WorkspaceMeta; added: boolean }>;
  editWorkspace(id: string, edit: { name?: string; color?: WorkspaceColor }): WorkspaceMeta;
  pinWorkspace(id: string, pinned: boolean): WorkspaceMeta;
  moveWorkspace(id: string, to: WorkspaceMove): WorkspaceMeta;
  shownTab(): { workspaceId: string; tabId: string } | null;
  claudeStatus(
    workspaceId: string,
    tabId: string,
  ): { status: ClaudeStatus; message?: string; since: number; turnStartedAt?: number } | null;
  hasRunningTerminals?(workspaceId: string): boolean;
  activity(workspaceId: string, tabId: string): TabActivity | null;
  claudeAsks(workspaceId: string, tabId: string): readonly PermissionAsk[];
  answerClaudeAsk(
    workspaceId: string,
    tabId: string,
    askId: string,
    answer: PermissionAnswer,
  ): Promise<boolean>;
  readonly claudeAgents: CliClaudeAgents;
  readonly waits: Pick<WaitRegistry, "begin">;
  ui<K extends CliUiOp>(
    op: K,
    args: CliUiOps[K]["args"],
    timeoutMs?: number,
  ): Promise<CliUiOps[K]["result"]>;
  notify(workspaceId: string, tabId: string, title: string, body: string): boolean;
  stat(workspaceId: string, relPath: string): Promise<FsEntryType | null>;
  readFile(workspaceId: string, absolutePath: string): Promise<string | null>;
  allowChange(request: ChangeRequest, signal?: AbortSignal): Promise<void>;
  askUser(request: ChangeRequest, signal?: AbortSignal): Promise<void>;
  agentContextEnabled(): boolean;
  claudeInstructions?(
    workspaceId: string,
    tabId: string,
    launch: string,
    hook: ClaudeInstructionHook,
  ): string;
  terminalClaudeInstructions?(workspaceId: string, profileId: string): string;
  foregroundProcess(workspaceId: string, tabId: string): Promise<string | null>;
  listeningPorts(workspaceId: string): Promise<readonly ListeningPort[]>;
  readonly forwards: CliForwards;
  readonly startedAgents: Pick<StartedAgents, "mark" | "since">;
  readonly clock: { now(): number; sleep(ms: number): Promise<void> };
  readonly browser: BrowserDriver;
  readonly notes: CliNotes;
}

export interface CliNotes {
  linksOfConversation(tab: NoteConversation): Promise<LinkedNote[]>;
  reportTargets(tab: NoteConversation): Promise<{ noteId: string; linkId: string }[]>;
  reportLine(tab: NoteConversation, noteId: string, report: LineReport): Promise<boolean>;
  list(workspaceId: string): Promise<NoteSummary[]>;
  read(workspaceId: string, noteId: string): Promise<NoteContent>;
  transcript(workspaceId: string, noteId: string): Promise<TranscriptFile>;
  create(workspaceId: string, title: string): Promise<NoteContent>;
  append(workspaceId: string, noteId: string, blocks: DocNode[], under?: string): Promise<void>;
  addAsset(
    workspaceId: string,
    noteId: string,
    bytes: Uint8Array,
    name: string,
  ): Promise<{ asset: NoteAsset; block: DocNode }>;
}

export interface CliCaller {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly verified?: boolean;
}

export interface CliContext {
  readonly caller: CliCaller;
  readonly invocation: CliInvocation;
  readonly services: CliServices;
  readonly signal?: AbortSignal;
}

const MIN_PREFIX = 4;

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

export function resolveWorkspace(ctx: CliContext, selector: string | undefined): WorkspaceMeta {
  const workspaces = ctx.services.listWorkspaces();
  const own = selector === undefined || selector === ".";
  const target = own ? ctx.caller.workspaceId : selector;
  return pick(
    workspaces,
    target,
    (w) => w.id,
    (w) => w.name,
    "workspace",
  );
}

export async function mayChange(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  change: CliChange,
  signal = ctx.signal,
): Promise<void> {
  if (workspace.id === ctx.caller.workspaceId) return;
  await ctx.services.allowChange(
    {
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId: workspace.id,
      change,
      ...(ctx.caller.verified === true ? { verified: true } : {}),
    },
    signal,
  );
}

export interface CliClaudeAgents {
  list(workspaceId: string, tabId: string): readonly AgentRun[];
  stop(workspaceId: string, tabId: string, agentId: string): Promise<boolean>;
  keepsSession?(workspaceId: string, tabId: string, runId: string): boolean;
}

export interface CliForwards {
  list(workspaceId: string): readonly PortForward[];
  forward(workspaceId: string, port: number): Promise<PortForward>;
  stop(workspaceId: string, port: number): Promise<void>;
  localUrl(workspaceId: string, url: string): Promise<string>;
}

export function placementFor(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  background: boolean,
): CliPlacement {
  return workspace.id === ctx.caller.workspaceId
    ? { background, besideTabId: ctx.caller.tabId }
    : { background };
}

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

export function describeLocation(workspace: WorkspaceMeta): string {
  const location = workspace.location;
  if (location.kind === "local") return location.rootPath;
  if (location.kind === "wsl") return `WSL ${location.distro}:${location.remotePath}`;
  const user = location.user ? `${location.user}@` : "";
  return `${user}${location.host}:${location.remotePath}`;
}
