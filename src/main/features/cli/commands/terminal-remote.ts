/**
 * nexus terminal ... --device: a terminal of another computer of the
 * user's, read, typed into, waited on and opened through the remote's room
 * as terminal read, send, key, wait and new do this computer's. What an
 * agent types there goes as its own (from), for that computer's user to
 * allow; the output is the local commands'.
 */
import {
  MAX_WAIT_MS as MAX_REQUEST_WAIT_MS,
  TERMINAL_KEYS,
  type TerminalKey,
} from "../../../../../packages/remote-protocol/src";
import { CliUsageError, type ParsedArgs } from "../args";
import { type CliContext, type CliDevice, CliError, shortId } from "../context";
import { oneLine } from "../format";
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
import { peerWaitOutput } from "./chat-remote";

function target(peer: PeerTab) {
  return { workspaceId: peer.workspace.id, tabId: peer.session.tabId };
}

function targetJson(peer: PeerTab) {
  return {
    tabId: peer.session.tabId,
    workspaceId: peer.workspace.id,
    device: deviceRef(peer.device),
  };
}

function named(peer: PeerTab): string {
  return `${peer.session.title} (${shortId(peer.session.tabId)}) on "${peer.device.name}"`;
}

function resolvePeerTerminal(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string | undefined,
): Promise<PeerTab> {
  if (selector === undefined) {
    throw new CliUsageError(`missing <tab>: which of "${device.name}"'s terminals`);
  }
  return resolvePeerTab(ctx, device, flags.workspace as string | undefined, selector, ["terminal"]);
}

/** terminal read --device. */
export async function readPeerTerminal(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string | undefined,
  lines: number,
): Promise<CliOutput> {
  const peer = await resolvePeerTerminal(ctx, device, flags, selector);
  const { text } = await askDevice(ctx, device, "terminal.read", {
    ...target(peer),
    lines: Math.min(lines, 5000),
  });
  return output(text, { id: peer.session.tabId, ...targetJson(peer), text });
}

/** How a terminal wait ended there, in the sentence the local wait says it in. */
function waitText(title: string, state: string, message: string | undefined): string {
  if (!message) return `${title}: ${state}.`;
  // The other computer sends the sentence itself when there is no answer to tell.
  if (message.startsWith("Claude Code ") || message.startsWith(title)) return message;
  switch (state) {
    case "completed":
      return `Claude Code finished:\n${message}`;
    case "needsInput":
      return `Claude Code is waiting for the user: ${message}`;
    case "error":
      return `Claude Code stopped on an error: ${message}`;
    case "permissionPending":
      return `Claude Code is waiting for the user to allow a tool: ${message}`;
    case "notified":
      return `${title} says: ${oneLine(message, 500)}`;
    default:
      return message;
  }
}

/** What terminal wait waits for there: idle, its program's exit, or a line. */
export interface PeerWaitFor {
  readonly exit?: boolean;
  readonly match?: string;
  readonly quietMs?: number;
}

/**
 * Waits on a terminal of another computer as waitOnTerminal does here,
 * with terminal.wait a slice at a time; `after` (terminal.input's `at`)
 * needs a turn begun after it. The computer going away ends it with
 * state offline.
 */
export async function waitOnPeerTerminal(
  ctx: CliContext,
  peer: PeerTab,
  waitFor: PeerWaitFor,
  timeoutMs: number,
  after?: number,
): Promise<WaitResult> {
  const { clock } = ctx.services;
  const startedAt = clock.now();
  for (;;) {
    const left = timeoutMs - (clock.now() - startedAt);
    const slice = Math.max(1, Math.min(MAX_REQUEST_WAIT_MS, left));
    const asked = clock.now();
    let answer: Awaited<ReturnType<typeof askDevice<"terminal.wait">>>;
    try {
      answer = await askDevice(ctx, peer.device, "terminal.wait", {
        ...target(peer),
        timeoutMs: slice,
        ...(after !== undefined ? { after } : {}),
        ...(waitFor.exit ? { exit: true } : {}),
        ...(waitFor.match !== undefined ? { match: waitFor.match } : {}),
        ...(waitFor.quietMs !== undefined ? { quietMs: waitFor.quietMs } : {}),
      });
    } catch (error) {
      if (!(error instanceof CliError && error.exitCode === 3)) throw error;
      return {
        done: false,
        state: "offline",
        text: `${error.message}: stopped waiting on ${peer.session.title}. Wait again when it is back.`,
      };
    }
    if (answer.done) {
      return {
        done: true,
        state: answer.state,
        text: waitText(peer.session.title, answer.state, answer.message),
        ...(answer.message ? { message: answer.message } : {}),
      };
    }
    if (clock.now() - startedAt >= timeoutMs || ctx.signal?.aborted) {
      return {
        done: false,
        state: "timeout",
        text: `${peer.session.title} was still busy when the wait ran out; see it with "nexus terminal read".`,
      };
    }
    // An answer sooner than asked: the other computer does not hold the wait.
    if (clock.now() - asked < slice / 2) await clock.sleep(WAIT_POLL_MS);
  }
}

/** terminal send --device: the text as one paste, then Enter unless told not to. */
export async function sendToPeerTerminal(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  input: { text: string; enter: boolean },
  wait: { timeoutMs: number; quietMs?: number } | null,
): Promise<CliOutput> {
  const peer = await resolvePeerTerminal(ctx, device, flags, selector);
  const from = await agentSenderOf(ctx);
  const { at } = await askDevice(ctx, device, "terminal.input", {
    ...target(peer),
    ...(input.text !== "" ? { text: input.text } : {}),
    ...(input.enter ? { enter: true } : {}),
    ...(from ? { from } : {}),
  });
  const sent = `Sent to ${named(peer)}.`;
  const json = { ...targetJson(peer), text: input.text, enter: input.enter };
  if (!wait) return output(sent, json);
  const result = await waitOnPeerTerminal(
    ctx,
    peer,
    wait.quietMs !== undefined ? { quietMs: wait.quietMs } : {},
    wait.timeoutMs,
    at,
  );
  return peerWaitOutput(`${sent}\n${result.text}`, json, result);
}

const KEY_ALIASES: Readonly<Record<string, TerminalKey>> = { return: "enter", escape: "esc" };
const KEYS: ReadonlySet<string> = new Set(TERMINAL_KEYS);

/**
 * Keys as terminal.input takes them, in order: runs of single characters
 * typed as text, and named keys pressed by name, each run a request.
 */
function keyRuns(names: readonly string[]): Array<{ text?: string; keys?: TerminalKey[] }> {
  const runs: Array<{ text?: string; keys?: TerminalKey[] }> = [];
  for (const name of names) {
    const lower = name.toLowerCase().replace(/^ctrl\+/, "ctrl-");
    const key = KEY_ALIASES[lower] ?? (KEYS.has(lower) ? (lower as TerminalKey) : undefined);
    const last = runs.at(-1);
    if (key) {
      // Keys go after a run's text, so they join it.
      if (last?.keys) last.keys.push(key);
      else if (last) last.keys = [key];
      else runs.push({ keys: [key] });
      continue;
    }
    if ([...name].length !== 1) {
      throw new CliUsageError(
        `unknown key "${name}". Keys: ${TERMINAL_KEYS.join(", ")}, or any single character.`,
      );
    }
    if (last && last.keys === undefined) last.text = `${last.text ?? ""}${name}`;
    else runs.push({ text: name });
  }
  return runs;
}

/** terminal key --device. */
export async function pressPeerKeys(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  keys: readonly string[],
): Promise<CliOutput> {
  const runs = keyRuns(keys);
  const peer = await resolvePeerTerminal(ctx, device, flags, selector);
  const from = await agentSenderOf(ctx);
  for (const run of runs) {
    await askDevice(ctx, device, "terminal.input", {
      ...target(peer),
      ...run,
      ...(from ? { from } : {}),
    });
  }
  return output(`Pressed ${keys.join(" ")} in ${named(peer)}.`, { ...targetJson(peer), keys });
}

/** terminal wait --device. */
export async function waitOnPeer(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
  selector: string,
  waitFor: PeerWaitFor,
  timeoutMs: number,
): Promise<CliOutput> {
  const peer = await resolvePeerTerminal(ctx, device, flags, selector);
  const result = await waitOnPeerTerminal(ctx, peer, waitFor, timeoutMs);
  return peerWaitOutput(result.text, targetJson(peer), result);
}

/** terminal new --device: a terminal in a workspace of the other computer. */
export async function newPeerTerminal(
  ctx: CliContext,
  device: CliDevice,
  flags: ParsedArgs["flags"],
): Promise<CliOutput> {
  if (flags.show !== undefined) throw new CliUsageError("--show is for this computer's tabs");
  const { workspaces } = await peerSessions(ctx, device);
  const workspace = pickPeerWorkspace(device, workspaces, flags.workspace as string | undefined);
  const given = (name: string) => {
    const value = flags[name];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const folder = given("cwd");
  const command = given("command");
  const title = given("title");
  const shell = given("shell");
  const from = await agentSenderOf(ctx);
  const { tabId } = await askDevice(ctx, device, "terminal.open", {
    workspaceId: workspace.id,
    ...(shell ? { shell } : {}),
    ...(folder ? { folder } : {}),
    ...(command ? { command } : {}),
    ...(title ? { title } : {}),
    ...(from ? { from } : {}),
  });
  const cwd = folder ?? workspace.path;
  return output(`Opened terminal ${shortId(tabId)} in ${cwd} on "${device.name}".`, {
    tabId,
    workspaceId: workspace.id,
    device: deviceRef(device),
    cwd,
  });
}
