/**
 * Whether an agent on another computer of the user's may do what it asks
 * here (a request with `from`, from that computer's nexus command): not
 * past MAX_AGENT_HOPS messages between agents, not more than
 * MAX_AGENT_REQUESTS_PER_MINUTE from one agent, and as the user set it
 * (Settings › Remote): allowed, turned down, or asked about as the nexus
 * command's changes to another workspace are: for this once, or for that
 * computer's workspace and this one until the app restarts.
 */
import {
  AGENT_CONSENT_MS,
  type AgentSender,
  MAX_AGENT_HOPS,
  MAX_AGENT_REQUESTS_PER_MINUTE,
  RpcErrorCode,
  type RpcMethod,
} from "../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../shared/chat/relay";
import type { CliChange, CliChangeKind } from "../../../shared/cli/ui";
import type { RemoteAgentsPolicy } from "../../../shared/types/app-state";
import type { CliServices } from "../cli/context";
import { RpcFailure } from "./room";

/** What the user is asked about each time, never for a while: answers, a looser mode, a profile. */
const EACH_TIME: ReadonlySet<CliChangeKind> = new Set([
  "permissionAllow",
  "permissionDeny",
  "chatMode",
  "chatProfile",
  "chatProfileNew",
]);

const MINUTE_MS = 60_000;

/** A request an agent made, as it came: from which device, for what. */
export interface AgentRequest {
  readonly device: { readonly id: string; readonly name: string };
  readonly method: RpcMethod;
  readonly params: { readonly workspaceId: string; readonly tabId?: string } & Record<
    string,
    unknown
  > & { readonly from: AgentSender };
}

export interface AgentGateDeps {
  policy(): RemoteAgentsPolicy;
  now?: () => number;
}

const forbidden = (message: string) => new RpcFailure(RpcErrorCode.Forbidden, message);

export class AgentGate {
  /** When each agent ("device|workspace|tab") asked lately, within the last minute. */
  private readonly recent = new Map<string, number[]>();
  /** "device|its workspace>this workspace" pairs the user allowed until restart. */
  private readonly allowed = new Set<string>();

  constructor(private readonly deps: AgentGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Resolves when the request may go ahead; a RpcFailure saying why when not. */
  async check(services: CliServices, request: AgentRequest): Promise<void> {
    const { device, params } = request;
    const { from } = params;
    if (from.hops > MAX_AGENT_HOPS) {
      throw forbidden(`the agents' chain is too long (${MAX_AGENT_HOPS} messages): a loop?`);
    }
    this.count(`${device.id}|${from.workspaceId}|${from.tabId}`);
    const policy = this.deps.policy();
    if (policy === "deny") throw forbidden("control by agents is off there (Settings › Remote)");
    if (policy === "allow") return;
    const change = await changeOf(services, request);
    const eachTime = EACH_TIME.has(change.kind);
    const pair = `${device.id}|${from.workspaceId}>${params.workspaceId}`;
    if (!eachTime && this.allowed.has(pair)) return;
    const { answer } = await services
      .ui(
        "consent.ask",
        {
          fromWorkspaceId: from.workspaceId,
          fromTabId: from.tabId,
          toWorkspaceId: params.workspaceId,
          change,
          timeoutMs: AGENT_CONSENT_MS,
          fromDevice: device.name,
          ...(from.name ? { fromName: from.name } : {}),
        },
        AGENT_CONSENT_MS + 10_000,
      )
      .catch((error: unknown) => {
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          error instanceof Error ? error.message : String(error),
        );
      });
    if (answer === "session" && !eachTime) this.allowed.add(pair);
    if (answer === "once" || answer === "session") return;
    throw forbidden(
      answer === "timeout"
        ? "the user there did not answer in time; nothing was done"
        : "the user there did not allow it",
    );
  }

  /** Counts a request of the agent `key`; Unavailable past the minute's share. */
  private count(key: string): void {
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (times.length >= MAX_AGENT_REQUESTS_PER_MINUTE) {
      this.recent.set(key, times);
      throw new RpcFailure(RpcErrorCode.Unavailable, "too many messages from that agent");
    }
    times.push(now);
    this.recent.set(key, times);
    // Agents that stopped asking are let go of.
    for (const [k, list] of this.recent) {
      if (list.every((at) => now - at >= MINUTE_MS)) this.recent.delete(k);
    }
  }
}

/** The agent's sender as the chat it writes to keeps it: who, on which computer, how far down the chain. */
export function relaySenderOf(
  from: AgentSender,
  device: { id: string; name: string },
): RelaySender {
  return {
    kind: from.kind,
    ...(from.agent === "claude" || from.agent === "codex" ? { agent: from.agent } : {}),
    ...(from.name ? { name: from.name.slice(0, 200) } : {}),
    workspaceId: from.workspaceId,
    tabId: from.tabId,
    device: { id: device.id, name: device.name.slice(0, 200) },
    hops: from.hops,
  };
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

async function tabTitle(services: CliServices, workspaceId: string, tabId: string) {
  const { tabs } = await services.ui("tabs.list", { workspaceId }).catch(() => ({ tabs: [] }));
  return tabs.find((t) => t.id === tabId)?.title ?? tabId.slice(0, 8);
}

/** What the user is asked to let the agent do, as the consent prompt says it. */
async function changeOf(
  services: CliServices,
  { method, params }: AgentRequest,
): Promise<CliChange> {
  const { workspaceId, tabId = "" } = params;
  const title = () => tabTitle(services, workspaceId, tabId);
  switch (method) {
    case "chat.send":
      return { kind: "chatInput", detail: await title() };
    case "chat.new":
      return { kind: "chatNew", detail: AGENT_NAMES[String(params.agent)] ?? String(params.agent) };
    case "chat.interrupt":
      return { kind: "chatInterrupt", detail: await title() };
    case "chat.configure":
      return typeof params.permissionMode === "string"
        ? { kind: "chatMode", detail: `"${await title()}" (${params.permissionMode})` }
        : { kind: "chatSettings", detail: await title() };
    case "chat.close":
    case "terminal.close":
      return { kind: "tabClose", detail: await title() };
    case "terminal.open":
      return { kind: "terminalNew" };
    case "terminal.input": {
      const typed = [
        typeof params.text === "string" ? params.text : "",
        ...(Array.isArray(params.keys) ? params.keys.map((k) => `<${String(k)}>`) : []),
        params.enter === true ? "<enter>" : "",
      ].join("");
      return { kind: "terminalInput", detail: await title(), ...(typed ? { body: typed } : {}) };
    }
    case "chat.answer": {
      const info = await services
        .ui("chat.state", { workspaceId, tabId, peek: true })
        .catch(() => null);
      const what = info?.waiting?.text ?? info?.request?.tool ?? (await title());
      return {
        kind: params.decision === "deny" ? "permissionDeny" : "permissionAllow",
        detail: what,
      };
    }
    case "terminal.answer": {
      const ask = services.claudeAsks(workspaceId, tabId).find((a) => a.id === params.requestId);
      const what = ask ? [ask.tool, ask.target].filter(Boolean).join(" ") : await title();
      return {
        kind: String(params.decision).startsWith("deny") ? "permissionDeny" : "permissionAllow",
        detail: what,
      };
    }
    default:
      throw forbidden(`${method} is not taken from agents`);
  }
}
