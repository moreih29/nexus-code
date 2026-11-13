/**
 * nexus chat ... --device and tab close --device: a Claude or Codex tab of
 * another computer of the user's, read and driven through the remote's
 * room as chat read, send, wait, new, answer, interrupt and set drive this
 * computer's. What an agent sends there goes as its own (from), for that
 * computer's user to allow; the output is the local commands'.
 */
import {
  MAX_READ_ITEMS,
  MAX_WAIT_MS as MAX_REQUEST_WAIT_MS,
  type RemoteSession,
} from "../../../../../packages/remote-protocol/src";
import type { CliChatEntry, CliChatInfo } from "../../../../shared/cli/ui";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { CliUsageError, type ParsedArgs } from "../args";
import { type CliContext, type CliDevice, CliError, shortId } from "../context";
import { type CliOutput, output } from "../registry";
import {
  agentSenderOf,
  askDevice,
  deviceRef,
  type PeerTab,
  peerSessions,
  pickPeerWorkspace,
  resolvePeerTab,
} from "../remote";
import { WAIT_POLL_MS, type WaitResult } from "../wait";
import { AGENT_NAMES, chatStateText, choicesText } from "./chat-text";

const CHATS: readonly RemoteSession["kind"][] = ["claude", "codex"];
/** Most items chat read --all or --since reads back through, a page at a time. */
const MAX_ITEMS = 5_000;

/** Where a remote tab is, as JSON names it. */
function targetJson(peer: PeerTab) {
  return {
    tabId: peer.session.tabId,
    workspaceId: peer.workspace.id,
    device: deviceRef(peer.device),
  };
}

function target(peer: PeerTab) {
  return { workspaceId: peer.workspace.id, tabId: peer.session.tabId };
}

function agentOf(session: RemoteSession): ChatAgent {
  return session.kind === "codex" ? "codex" : "claude";
}

/** A tab as the text names it: its title, id, and computer. */
function named(peer: PeerTab): string {
  return `${peer.session.title} (${shortId(peer.session.tabId)}) on "${peer.device.name}"`;
}

/** Whether a failure is the other computer going offline (or this one leaving the room). */
function wentAway(error: unknown): boolean {
  return error instanceof CliError && error.exitCode === 3;
}

/**
 * Waits on chats of another computer, as waitOnChats does here: until one
 * is done with its turn. Each chat.wait waits on the other computer, at
 * most its MAX_WAIT_MS; `after` (a chat.send's `at`) counts a message not
 * shown yet as work. The computer going away ends it with state offline.
 */
export async function waitOnPeerChats(
  ctx: CliContext,
  peers: readonly PeerTab[],
  timeoutMs: number,
  after?: number,
): Promise<WaitResult & { peer?: PeerTab }> {
  const { clock } = ctx.services;
  const startedAt = clock.now();
  const share = Math.max(1_000, Math.floor(MAX_REQUEST_WAIT_MS / peers.length));
  for (;;) {
    for (const peer of peers) {
      const left = timeoutMs - (clock.now() - startedAt);
      const asked = clock.now();
      const slice = Math.max(1, Math.min(share, left));
      let answer: Awaited<ReturnType<typeof askDevice<"chat.wait">>>;
      try {
        answer = await askDevice(ctx, peer.device, "chat.wait", {
          ...target(peer),
          timeoutMs: slice,
          ...(after !== undefined ? { after } : {}),
        });
      } catch (error) {
        if (!wentAway(error)) throw error;
        return {
          done: false,
          state: "offline",
          text: `${(error as Error).message}: stopped waiting on ${peer.session.title}. Wait again when it is back.`,
          peer,
        };
      }
      if (answer.done) {
        const text =
          answer.state === "closed"
            ? `${peer.session.title} was closed.`
            : chatStateText(peer.session, {
                agent: agentOf(peer.session),
                state: answer.state,
                ...(answer.message ? { message: answer.message } : {}),
              });
        return {
          done: true,
          state: answer.state,
          text,
          ...(answer.message ? { message: answer.message } : {}),
          peer,
        };
      }
      // An answer sooner than asked: the other computer does not hold the wait.
      if (clock.now() - asked < slice / 2) await clock.sleep(WAIT_POLL_MS);
    }
    if (clock.now() - startedAt >= timeoutMs || ctx.signal?.aborted) {
      const which = peers.length === 1 ? (peers[0] as PeerTab).session.title : "every tab";
      return {
        done: false,
        state: "timeout",
        text: `${which} was still working when the wait ran out; see it with "nexus chat read".`,
      };
    }
  }
}

/** A wait's result as the command prints it: exit 3 when the computer went away, 124 when it ran out. */
export function peerWaitOutput(
  text: string,
  json: Record<string, unknown>,
  result: WaitResult,
): CliOutput {
  return output(
    text,
    { ...json, state: result.state, ...(result.message ? { message: result.message } : {}) },
    result.done ? {} : { exitCode: result.state === "offline" ? 3 : 124 },
  );
}

/** chat send --device. */
export async function sendToPeer(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  text: string,
  timeoutMs: number | null,
): Promise<CliOutput> {
  const peer = await resolvePeerTab(
    ctx,
    device,
    flags.workspace as string | undefined,
    selector,
    CHATS,
  );
  const from = await agentSenderOf(ctx);
  const { at } = await askDevice(ctx, device, "chat.send", {
    ...target(peer),
    text,
    ...(from ? { from } : {}),
  });
  const sent = `Sent to ${named(peer)}.`;
  const json = { ...targetJson(peer), text };
  if (timeoutMs === null) return output(sent, json);
  const result = await waitOnPeerChats(ctx, [peer], timeoutMs, at);
  return peerWaitOutput(`${sent}\n${result.text}`, json, result);
}

/** chat wait --device: the first of the tabs to be done. */
export async function waitOnPeer(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selectors: readonly string[],
  timeoutMs: number,
): Promise<CliOutput> {
  const peers: PeerTab[] = [];
  for (const selector of selectors) {
    const peer = await resolvePeerTab(
      ctx,
      device,
      flags.workspace as string | undefined,
      selector,
      CHATS,
    );
    if (!peers.some((p) => p.session.tabId === peer.session.tabId)) peers.push(peer);
  }
  const result = await waitOnPeerChats(ctx, peers, timeoutMs);
  const which = result.peer ?? (peers.length === 1 ? peers[0] : undefined);
  return peerWaitOutput(
    result.text,
    which ? targetJson(which) : { device: deviceRef(device) },
    result,
  );
}

/** What chat read asks of a remote tab. */
export interface PeerReadQuery {
  readonly messages?: number;
  readonly since?: number;
  readonly all: boolean;
  readonly subagents: boolean;
}

/**
 * chat read --device: the tab's items as the other computer draws them,
 * told here as chat read tells this computer's, each entry numbered by its
 * item's place there; where it stands, as chat wait would say it now.
 */
export async function readPeerChat(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  query: PeerReadQuery,
): Promise<{
  peer: PeerTab;
  info: CliChatInfo;
  entries: CliChatEntry[];
  end: number;
}> {
  const peer = await resolvePeerTab(
    ctx,
    device,
    flags.workspace as string | undefined,
    selector,
    CHATS,
  );
  const back = query.all || query.since !== undefined;
  let page = await askDevice(ctx, device, "chat.read", {
    ...target(peer),
    limit: back ? MAX_READ_ITEMS : Math.min(query.messages ?? 20, MAX_READ_ITEMS),
  });
  // Cleared or rewound since #since: from its start, as here.
  const end = page.total - 1;
  const since = query.since !== undefined && query.since <= end ? query.since : -1;
  if (back) {
    let read = page.items.length;
    while (page.start > since + 1 && page.start > 0 && read < MAX_ITEMS) {
      const before = await askDevice(ctx, device, "chat.read", {
        ...target(peer),
        before: page.start,
        limit: MAX_READ_ITEMS,
      });
      if (before.items.length === 0) break;
      read += before.items.length;
      page = {
        ...page,
        start: before.start,
        items: [...before.items, ...page.items],
        tools: { ...before.tools, ...page.tools },
      };
    }
  }
  const { entries: all } = await ctx.services.ui("chat.pageEntries", {
    page,
    ...(query.subagents ? { subagents: true } : {}),
  });
  const after = all.filter((entry) => entry.i > since);
  const entries =
    query.messages === undefined ? after : after.slice(Math.max(0, after.length - query.messages));
  const now = await askDevice(ctx, device, "chat.wait", { ...target(peer), timeoutMs: 1 });
  const info: CliChatInfo = {
    agent: page.status.agent,
    // A tab closed since it was listed reads as it was last.
    state: now.state === "closed" ? "idle" : now.state,
    ...(now.message ? { message: now.message } : {}),
    ...(peer.session.since !== undefined ? { since: peer.session.since } : {}),
    ...(peer.session.profile ? { profile: peer.session.profile } : {}),
  };
  return { peer, info, entries, end };
}

/** chat new --device: a tab in a workspace of the other computer, sent the prompt if given. */
export async function newPeerChat(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  request: {
    agent: ChatAgent;
    prompt: string;
    folder?: string;
    settings: { model?: string; effort?: string; mode?: string };
  },
): Promise<CliOutput> {
  if (flags.show !== undefined) throw new CliUsageError("--show is for this computer's tabs");
  const { workspaces } = await peerSessions(ctx, device);
  const workspace = pickPeerWorkspace(device, workspaces, flags.workspace as string | undefined);
  const { agent, prompt, folder, settings } = request;
  const from = prompt !== "" ? await agentSenderOf(ctx) : undefined;
  const profile = typeof flags.profile === "string" ? flags.profile.trim() : "";
  const { tabId, error } = await askDevice(ctx, device, "chat.new", {
    workspaceId: workspace.id,
    agent,
    ...(prompt !== "" ? { prompt } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.mode ? { permissionMode: settings.mode } : {}),
    ...(profile ? { profile } : {}),
    ...(folder ? { folder } : {}),
    ...(from ? { from } : {}),
  });
  const where = `${folder ?? workspace.path} on "${device.name}"`;
  const json = {
    tabId,
    workspaceId: workspace.id,
    device: deviceRef(device),
    agent,
    cwd: folder ?? workspace.path,
  };
  if (error !== undefined) {
    const sent = prompt === "" ? "" : " The prompt was not sent.";
    return output(
      `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${where}, but could not set it: ${error}.${sent}`,
      { ...json, error },
      { exitCode: 1 },
    );
  }
  const text =
    prompt === ""
      ? `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${where}.`
      : `Opened ${AGENT_NAMES[agent]} tab ${shortId(tabId)} in ${where} and sent it the prompt. To wait for it:\n` +
        `  nexus chat wait ${shortId(tabId)} --workspace ${shortId(workspace.id)} --device ${shortId(device.id)}`;
  return output(text, json);
}

/** chat interrupt --device. */
export async function interruptPeer(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
): Promise<CliOutput> {
  const peer = await resolvePeerTab(
    ctx,
    device,
    flags.workspace as string | undefined,
    selector,
    CHATS,
  );
  const from = await agentSenderOf(ctx);
  await askDevice(ctx, device, "chat.interrupt", { ...target(peer), ...(from ? { from } : {}) });
  return output(`Stopped the turn of ${named(peer)}.`, targetJson(peer));
}

/**
 * chat set --device: what the tab runs with and takes, or sets its model,
 * effort or mode as the other computer lets it.
 */
export async function setPeerChat(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  settingsOf: (agent: ChatAgent) => { model?: string; effort?: string; mode?: string },
): Promise<CliOutput> {
  if (flags.profile !== undefined || flags.new !== undefined) {
    throw new CliUsageError("--profile is for this computer's tabs");
  }
  const peer = await resolvePeerTab(
    ctx,
    device,
    flags.workspace as string | undefined,
    selector,
    CHATS,
  );
  const settings = settingsOf(agentOf(peer.session));
  const choicesOf = (s: Awaited<ReturnType<typeof askDevice<"chat.settings">>>) => ({
    agent: s.agent,
    model: s.model,
    effort: s.effort,
    mode: s.permissionMode,
    models: s.options.models.map((m) => ({ value: m.id, name: m.label })),
    efforts: s.options.efforts,
  });
  if (Object.keys(settings).length === 0) {
    const now = await askDevice(ctx, device, "chat.settings", target(peer));
    const choices = choicesOf(now);
    return output(choicesText({ title: `${peer.session.title} on "${device.name}"` }, choices), {
      ...targetJson(peer),
      ...choices,
    });
  }
  const from = await agentSenderOf(ctx);
  const set = await askDevice(ctx, device, "chat.configure", {
    ...target(peer),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.mode ? { permissionMode: settings.mode } : {}),
    ...(from ? { from } : {}),
  });
  const choices = choicesOf(set);
  const runs = [
    `model ${choices.model ?? "(its default)"}`,
    `effort ${choices.effort ?? "(the model's default)"}`,
    `mode ${choices.mode}`,
  ].join(", ");
  return output(`${named(peer)} now runs with ${runs}.`, { ...targetJson(peer), ...choices });
}

/** The tools whose requests are a question or a plan for the user, not a tool to allow. */
const USERS_TO_ANSWER = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * chat answer --device: the permission request a Claude or Codex tab, or a
 * terminal's Claude Code, waits on there.
 */
export async function answerPeer(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  decision: "allow" | "deny",
  message: string | undefined,
): Promise<CliOutput> {
  const peer = await resolvePeerTab(ctx, device, flags.workspace as string | undefined, selector);
  const { session } = peer;
  const from = await agentSenderOf(ctx);
  const done = (tool: string) =>
    output(`${decision === "allow" ? "Allowed" : "Denied"} ${tool} in ${named(peer)}.`, {
      ...targetJson(peer),
      decision,
      tool,
    });
  if (session.kind === "terminal") {
    if (message !== undefined) {
      throw new CliUsageError("--message goes to a Claude or Codex tab, not a terminal");
    }
    const requestId = session.waiting?.requestId;
    if (!requestId) throw new CliError(`${session.title} waits on no permission request`);
    await askDevice(ctx, device, "terminal.answer", {
      ...target(peer),
      requestId,
      decision,
      ...(from ? { from } : {}),
    });
    return done(session.waiting?.text ?? "the tool");
  }
  const page = await askDevice(ctx, device, "chat.read", { ...target(peer), limit: 1 });
  const request = page.status.permissions[0];
  if (!request) throw new CliError(`${session.title} waits on no permission request`);
  if (USERS_TO_ANSWER.has(request.toolName)) {
    throw new CliError(
      `${session.title} asks the user ${request.toolName === "ExitPlanMode" ? "about a plan" : "a question"}; that is the user's to answer in the app`,
    );
  }
  await askDevice(ctx, device, "chat.answer", {
    ...target(peer),
    requestId: request.requestId,
    decision,
    ...(message ? { message } : {}),
    ...(from ? { from } : {}),
  });
  return done(request.displayName ?? request.toolName);
}

/** tab close --device: a chat or a terminal of the other computer; a running one only with --force. */
export async function closePeerTab(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
): Promise<CliOutput> {
  const peer = await resolvePeerTab(ctx, device, flags.workspace as string | undefined, selector);
  const from = await agentSenderOf(ctx);
  if (peer.session.kind === "terminal") {
    await askDevice(ctx, device, "terminal.close", {
      ...target(peer),
      ...(flags.force === true ? { force: true } : {}),
      ...(from ? { from } : {}),
    });
  } else {
    await askDevice(ctx, device, "chat.close", { ...target(peer), ...(from ? { from } : {}) });
  }
  return output(`Closed ${named(peer)}.`, targetJson(peer));
}
