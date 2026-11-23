import {
  MAX_AGENT_DESCRIPTION,
  MAX_SESSION_AGENTS,
  MAX_SESSION_OPENER_NAME,
  type RemoteSession,
  type RemoteSessionAgent,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcParams,
  type RpcRequest,
  type RpcResult,
  type SessionState,
} from "../../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../../shared/claude/activity";
import type {
  CliChatState,
  CliSessionsSnapshotCursor,
  CliSessionTab,
  CliUiOps,
} from "../../../../shared/cli/ui";
import { describeTerminal, isAgentSession } from "../../../../shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { compareWorkspaceOrder } from "../../../../shared/workspace-order";
import type { CliServices, SessionsRenderer, SessionsRevision } from "../../cli/context";
import { type ConsentControls, remoteConsents } from "../consents";
import type { RemoteNotes } from "../notes";
import { RpcFailure } from "../room";
import { fitSessionReply } from "../session-list-size";
import { SESSIONS_POLL_MS } from "../session-watches";
import { oneLine, unavailable, workspaceOf } from "./common";
import { RENDERER_READ_MAX_MS, ReadBudget } from "./read-budget";

const CHAT_STATES: Record<CliChatState, SessionState> = {
  working: "running",
  asking: "needs-you",
  idle: "idle",
  error: "idle",
};

function terminalSessionState(state: string): SessionState {
  if (state === "needsInput" || state === "permissionPending") return "needs-you";
  if (state === "running" || state === "busy") return "running";
  if (state === "completed") return "new-result";
  return "idle";
}

function ordered(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  const roots = workspaces.filter((w) => !w.task).sort(compareWorkspaceOrder);
  const out: WorkspaceMeta[] = [];
  for (const root of roots)
    out.push(root, ...workspaces.filter((w) => w.task?.parentId === root.id));
  for (const w of workspaces) if (!out.includes(w)) out.push(w);
  return out;
}

export function sessionAgents(agents: readonly AgentRun[]): RemoteSessionAgent[] | undefined {
  const live = agents.filter((agent) => agent.end === undefined).slice(0, MAX_SESSION_AGENTS);
  if (live.length === 0) return undefined;
  return live.map((agent) => {
    const said = agent.description ?? (agent.kind === "print" ? agent.prompt : undefined);
    const description = said ? oneLine(said, MAX_AGENT_DESCRIPTION) : "";
    return {
      id: agent.id,
      kind: agent.kind,
      ...(agent.program ? { program: agent.program } : {}),
      ...(agent.type ? { type: oneLine(agent.type, 60) } : {}),
      ...(description ? { description } : {}),
      state: agent.state,
      start: agent.start,
    };
  });
}

function agentsField(
  services: CliServices,
  workspaceId: string,
  tabId: string,
): { agents?: RemoteSessionAgent[] } {
  const agents = sessionAgents(services.claudeAgents.list(workspaceId, tabId));
  return agents ? { agents } : {};
}

const UNREAD_RESULTS_MAX_AGE_MS = 30_000;

type UnreadResults = CliUiOps["sessions.results"]["result"]["unread"];
const lastUnreadResults = new WeakMap<
  CliServices | SessionsRenderer,
  { startedAt: number; unread: UnreadResults }
>();

function unreadResults(
  source: CliServices | SessionsRenderer | undefined,
  startedAt: number,
  unread: UnreadResults | undefined,
): { unread?: UnreadResults; readAt: number } {
  if (!source) return { unread, readAt: startedAt };
  const last = lastUnreadResults.get(source);
  if (unread && (!last || startedAt >= last.startedAt)) {
    lastUnreadResults.set(source, { startedAt, unread });
    return { unread, readAt: startedAt };
  }
  if (last && performance.now() - last.startedAt < UNREAD_RESULTS_MAX_AGE_MS) {
    return { unread: last.unread, readAt: last.startedAt };
  }
  lastUnreadResults.delete(source);
  return { readAt: startedAt };
}

interface Receipt {
  readonly upTo: number;
  readonly requestedAt: number;
  takenAt: number;
}

const RECEIPT_MAX_AGE_MS = UNREAD_RESULTS_MAX_AGE_MS;

const receipts = new WeakMap<SessionsRevision, Map<string, Receipt[]>>();

const receiptKey = (workspaceId: string, tabId: string) => `${workspaceId}\0${tabId}`;

function liveReceipts(revisions: SessionsRevision): Map<string, Receipt[]> {
  let byTab = receipts.get(revisions);
  if (!byTab) {
    byTab = new Map();
    receipts.set(revisions, byTab);
  }
  const now = performance.now();
  for (const [key, list] of byTab) {
    const live = list.filter(
      (r) =>
        now - r.requestedAt < RECEIPT_MAX_AGE_MS ||
        (Number.isFinite(r.takenAt) && now - r.takenAt < RECEIPT_MAX_AGE_MS),
    );
    if (live.length === 0) byTab.delete(key);
    else if (live.length < list.length) byTab.set(key, live);
  }
  return byTab;
}

export function holdReceipts(
  services: CliServices,
  seen: RpcParams<"sessions.markSeen">["seen"],
): { taken(): void; failed(): void } {
  const revisions = services.sessionsRevision;
  if (!revisions) return { taken() {}, failed() {} };
  const byTab = liveReceipts(revisions);
  const held = seen.map(({ workspaceId, tabId, upTo }) => {
    const receipt: Receipt = { upTo, requestedAt: performance.now(), takenAt: Infinity };
    const key = receiptKey(workspaceId, tabId);
    byTab.set(key, [...(byTab.get(key) ?? []), receipt]);
    return { key, receipt };
  });
  return {
    taken() {
      const now = performance.now();
      for (const { receipt } of held) receipt.takenAt = now;
    },
    failed() {
      for (const { key, receipt } of held) {
        const rest = (byTab.get(key) ?? []).filter((r) => r !== receipt);
        if (rest.length > 0) byTab.set(key, rest);
        else byTab.delete(key);
      }
    },
  };
}

function receiptCovers(
  byTab: ReadonlyMap<string, readonly Receipt[]> | undefined,
  workspaceId: string,
  tabId: string,
  since: number,
  readAt: number,
): boolean {
  return (
    byTab
      ?.get(receiptKey(workspaceId, tabId))
      ?.some((r) => since <= r.upTo && readAt <= r.takenAt) ?? false
  );
}

export const SESSIONS_REREAD_MS = 10_000 - SESSIONS_POLL_MS - RENDERER_READ_MAX_MS;

interface RendererRead {
  readonly tabs: readonly (readonly CliSessionTab[] | undefined)[];
  readonly unread: UnreadResults | undefined;
  readonly unreadAt: number;
}

type SessionsSnapshot = CliUiOps["sessions.snapshot"]["result"];

const lastReads = new WeakMap<
  SessionsRenderer,
  { key: string; revision: number; readAt: number; read: RendererRead }
>();

function wholeRead(snapshot: SessionsSnapshot, workspaces: number): boolean {
  return (
    snapshot.unread !== undefined &&
    snapshot.workspaces.length === workspaces &&
    snapshot.workspaces.every(
      ({ tabs }) =>
        tabs?.every((tab) => (tab.type !== "claude" && tab.type !== "codex") || tab.chat) ?? false,
    )
  );
}

async function readSnapshot(
  budget: ReadBudget,
  workspaceIds: string[],
  renderer: SessionsRenderer | undefined,
): Promise<SessionsSnapshot | undefined> {
  const ask = async (cursor?: CliSessionsSnapshotCursor) => {
    if (renderer?.closed) return undefined;
    const page = await budget
      .ui(
        "sessions.snapshot",
        { workspaceIds, ...(cursor ? { cursor } : {}) },
        undefined,
        renderer?.snapshot,
      )
      .catch(() => undefined);
    if (renderer?.closed) return undefined;
    if (page && Number.isSafeInteger(page.revision)) renderer?.saw(page.revision);
    return page;
  };
  const first = await ask();
  if (!first?.next) return first;

  const workspaces = [...first.workspaces];
  let next: CliSessionsSnapshotCursor | undefined = first.next;
  while (next) {
    const { workspace, tab } = next;
    const page = await ask(next);
    if (renderer?.closed) return undefined;
    if (!page || page.revision !== first.revision) {
      workspaces.length = workspace;
      break;
    }
    if (tab > 0) {
      const previous = workspaces[workspace]?.tabs;
      const more = page.workspaces[0]?.tabs;
      workspaces[workspace] = previous && more ? { tabs: [...previous, ...more] } : {};
    }
    workspaces.push(...page.workspaces.slice(tab > 0 ? 1 : 0));
    next = page.next;
  }
  return { revision: first.revision, workspaces, unread: first.unread };
}

async function readRenderer(
  services: CliServices,
  budget: ReadBudget,
  workspaceIds: string[],
): Promise<RendererRead> {
  const renderer = services.sessionsRevision?.current();
  const key = workspaceIds.join("\n");
  const last = renderer && lastReads.get(renderer);
  if (
    renderer &&
    last &&
    last.key === key &&
    last.revision === renderer.latest &&
    performance.now() - last.readAt < SESSIONS_REREAD_MS
  ) {
    return last.read;
  }
  const startedAt = performance.now();
  const snapshot = await readSnapshot(budget, workspaceIds, renderer);
  const source = services.sessionsRevision ? (renderer?.closed ? undefined : renderer) : services;
  const { unread, readAt } = unreadResults(source, startedAt, snapshot?.unread);
  const read: RendererRead = {
    tabs: workspaceIds.map((_, index) => snapshot?.workspaces[index]?.tabs),
    unread,
    unreadAt: readAt,
  };
  if (
    renderer &&
    !renderer.closed &&
    snapshot &&
    snapshot.revision === renderer.latest &&
    startedAt >= (lastReads.get(renderer)?.readAt ?? -Infinity) &&
    wholeRead(snapshot, workspaceIds.length)
  ) {
    lastReads.set(renderer, { key, revision: snapshot.revision, readAt: startedAt, read });
  }
  return read;
}

function clipOpenerName(name: string): string {
  return name.slice(0, MAX_SESSION_OPENER_NAME).replace(/[\uD800-\uDBFF]$/u, "");
}

function openerField(opener: CliSessionTab["openedBy"]): Pick<RemoteSession, "openedBy"> {
  if (!opener?.workspaceId || !opener.tabId || opener.kind === "manager") return {};
  const { workspaceId, tabId, kind, agent, name, device } = opener;
  return {
    openedBy: {
      workspaceId,
      tabId,
      kind,
      ...(agent === undefined ? {} : { agent }),
      ...(name === undefined ? {} : { name: clipOpenerName(name) }),
      ...(device ? { device: { id: device.id, name: clipOpenerName(device.name) } } : {}),
    },
  };
}

function chatSession(
  services: CliServices,
  workspaceId: string,
  tab: CliSessionTab,
): { row: RemoteSession; waitingId?: string } | undefined {
  if (tab.type !== "claude" && tab.type !== "codex") return undefined;
  const info = tab.chat;
  if (!info) return undefined;
  const row: RemoteSession = {
    workspaceId,
    tabId: tab.id,
    kind: tab.type,
    title: tab.title,
    state: CHAT_STATES[info.state],
    ...(info.state === "error" ? { failed: true } : {}),
    ...(info.since !== undefined ? { since: info.since } : {}),
    ...(info.message !== undefined ? { last: oneLine(info.message) } : {}),
    ...(info.profile ? { profile: info.profile } : {}),
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.state === "asking" && info.waiting
      ? { waiting: { kind: info.waiting.kind, text: oneLine(info.waiting.text) } }
      : {}),
    ...(info.limitResume?.state === "waiting" && info.limitResume.at !== undefined
      ? { limitWait: { at: info.limitResume.at } }
      : {}),
    ...agentsField(services, workspaceId, tab.id),
    ...openerField(tab.openedBy),
  };
  return { row, ...(row.waiting && info.waitingId ? { waitingId: info.waitingId } : {}) };
}

function terminalSession(
  services: CliServices,
  workspaceId: string,
  tab: CliSessionTab,
  now: number,
): RemoteSession {
  const claude = services.claudeStatus(workspaceId, tab.id);
  const state = describeTerminal(claude, services.activity(workspaceId, tab.id), tab.title, now);
  const agent = isAgentSession(state) ? (state.agent ?? "agent") : undefined;
  const status = agent ? (tab.dead ? "ended" : terminalSessionState(state.state)) : "idle";
  const ask = tab.dead ? undefined : terminalAsk(services, workspaceId, tab.id, claude?.status);
  return {
    workspaceId,
    tabId: tab.id,
    kind: "terminal",
    title: tab.title,
    state: status,
    ...(state.state === "error" ? { failed: true } : {}),
    ...(agent ? { agent } : {}),
    ...(state.since !== undefined ? { since: state.since } : {}),
    ...(state.message ? { last: oneLine(state.message) } : {}),
    ...(ask
      ? {
          waiting: {
            kind: "permission",
            text: oneLine(ask.target ? `${ask.tool} ${ask.target}` : ask.tool),
            requestId: ask.id,
            always: ask.always.length > 0,
            subagent: ask.agentId !== undefined,
          },
        }
      : {}),
    ...(tab.dead ? {} : agentsField(services, workspaceId, tab.id)),
    ...openerField(tab.openedBy),
  };
}

function terminalAsk(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  status: string | undefined,
) {
  return status === "permissionPending" ? services.claudeAsks(workspaceId, tabId)[0] : undefined;
}

export async function listSessions(
  services: CliServices,
  git?: WorkspaceGit,
): Promise<RpcResult<"sessions.list">> {
  return (await snapshotSessions(services, git)).list;
}

export async function serveSessionsList(
  services: CliServices,
  git: WorkspaceGit | undefined,
  notes: RemoteNotes | undefined,
  from: string,
  controls: ConsentControls,
  id: RpcRequest["id"] = 0,
): Promise<RpcResult<"sessions.list">> {
  const snapshot = await snapshotSessions(services, git, notes, "sessions.list", from);
  const list = await snapshot.forDevice(controls);
  return fitSessionReply(list, id)?.list ?? list;
}

export async function reorderSessions(
  services: CliServices,
  params: RpcParams<"sessions.reorder">,
): Promise<RpcResult<"sessions.reorder">> {
  const notFound = () => new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  if (!workspaceOf(services, params.workspaceId)) throw notFound();
  const { found } = await services.ui("agentView.reorderSessions", params).catch(unavailable);
  if (!found) throw notFound();
  return {};
}

export async function snapshotSessions(
  services: CliServices,
  git: WorkspaceGit | undefined,
  notes?: RemoteNotes,
  method: "sessions.list" | "sessions.watch" = "sessions.watch",
  from?: string,
  includeWaitingIds = false,
) {
  const budget = new ReadBudget(services, method, from, RENDERER_READ_MAX_MS);
  const workspaces = ordered(services.listWorkspaces());
  const listed: RemoteWorkspace[] = workspaces.map((w) => {
    const facts = w.task ? git?.(w) : undefined;
    return {
      id: w.id,
      name: w.name,
      path: w.rootPath,
      ...(w.task ? { parentId: w.task.parentId } : {}),
      ...(!w.task && w.pinned ? { pinned: true } : {}),
      ...(facts ? { git: facts } : {}),
    };
  });
  const now = Date.now();
  const read = await readRenderer(
    services,
    budget,
    workspaces.map(({ id }) => id),
  );

  const incompleteWorkspaces = new Set<string>();
  const tabsByWorkspace = new Map<string, readonly CliSessionTab[]>();
  const sessions: (RemoteSession | undefined)[] = [];
  const waitingIds = new Map<number, string>();
  const chats: { index: number; workspaceId: string; tab: CliSessionTab }[] = [];
  for (const [index, { id: workspaceId }] of workspaces.entries()) {
    const tabs = read.tabs[index];
    if (!tabs) {
      incompleteWorkspaces.add(workspaceId);
      continue;
    }
    tabsByWorkspace.set(workspaceId, tabs);
    for (const tab of tabs) {
      if (tab.type === "claude" || tab.type === "codex") {
        chats.push({ index: sessions.length, workspaceId, tab });
        sessions.push(undefined);
      } else if (tab.type === "terminal" && !tab.unstarted) {
        sessions.push(terminalSession(services, workspaceId, tab, now));
      }
    }
  }
  for (const { index, workspaceId, tab } of chats) {
    const result = chatSession(services, workspaceId, tab);
    sessions[index] = result?.row;
    if (includeWaitingIds && result?.waitingId) waitingIds.set(index, result.waitingId);
  }
  for (const { index, workspaceId } of chats) {
    if (!sessions[index]) incompleteWorkspaces.add(workspaceId);
  }
  const rows = sessions.filter((row) => row !== undefined);
  const tabIds = new Set(rows.map(({ tabId }) => tabId));
  const unread = read.unread;
  const taken = services.sessionsRevision && liveReceipts(services.sessionsRevision);
  const recording = notes?.recording();
  const list: RpcResult<"sessions.list"> = {
    workspaces: listed,
    sessions: rows.map((row) => {
      const opener = row.openedBy;
      if (opener?.name !== undefined && !opener.device && tabIds.has(opener.tabId)) {
        const { name: _name, ...reference } = opener;
        row = { ...row, openedBy: reference };
      }
      if (!unread || (row.state !== "idle" && row.state !== "new-result")) return row;
      const since = unread[row.workspaceId]?.[row.tabId];
      if (
        !row.failed &&
        !row.limitWait &&
        !row.waiting &&
        since !== undefined &&
        Number.isFinite(since) &&
        !receiptCovers(taken, row.workspaceId, row.tabId, since, read.unreadAt)
      )
        return { ...row, state: "new-result", since };
      return row.state === "new-result" ? { ...row, state: "idle" } : row;
    }),
    ...(incompleteWorkspaces.size > 0 ? { incompleteWorkspaces: [...incompleteWorkspaces] } : {}),
    ...(recording ? { recording } : {}),
  };
  const waitingRequests = includeWaitingIds
    ? sessions.flatMap((row, index) => {
        if (!row?.waiting) return [];
        const { workspaceId, tabId, kind } = row;
        const id = row.waiting.requestId ?? waitingIds.get(index);
        if (!id) return [];
        if (
          kind === "terminal" &&
          terminalAsk(
            services,
            workspaceId,
            tabId,
            services.claudeStatus(workspaceId, tabId)?.status,
          )?.id !== id
        )
          return [];
        return [{ workspaceId, key: JSON.stringify([workspaceId, tabId, kind, id]) }];
      })
    : [];
  budget.report();
  return {
    list,
    incompleteWorkspaces,
    waitingRequests,
    async forDevice(controls: ConsentControls): Promise<RpcResult<"sessions.list">> {
      const consents = await remoteConsents(
        services,
        controls,
        Date.now(),
        async (id) => tabsByWorkspace.get(id) ?? [],
      );
      return { ...list, consents };
    },
  };
}

export type WorkspaceGit = (workspace: WorkspaceMeta) => RemoteWorkspace["git"] | undefined;
