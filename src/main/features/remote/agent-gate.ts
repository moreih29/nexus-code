/**
 * Whether an agent on another computer of the user's may do what it asks
 * here (a request with `from`, from that computer's nexus command): not
 * more than MAX_AGENT_REQUESTS_PER_MINUTE from one agent nor
 * MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE from all of one device's, not more
 * than MAX_PENDING_PROMPTS_PER_DEVICE prompts of one device's waiting on
 * the user at once, and as the user set it
 * (Settings › Remote): allowed, turned down, or asked about as the nexus
 * command's changes to another workspace are: for this once, or for every
 * change from that computer's workspace to this one until the app restarts.
 */
import {
  AGENT_CONSENT_MS,
  type AgentSender,
  MAX_AGENT_REQUESTS_PER_MINUTE,
  MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE,
  RpcErrorCode,
  type RpcMethod,
} from "../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../shared/chat/relay";
import type { CliChange } from "../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed, loosens } from "../../../shared/sessions/chat-modes";
import type { RemoteAgentsPolicy } from "../../../shared/types/app-state";
import type { CliServices } from "../cli/context";
import { filePathRules } from "./file-io";
import { findNote } from "./notes";
import { RpcFailure } from "./room";

const MINUTE_MS = 60_000;

/**
 * Most prompts one device's agents may have waiting on the user here at
 * once: more are turned away, not stacked up behind the ones shown.
 */
export const MAX_PENDING_PROMPTS_PER_DEVICE = 3;

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

const FILE_CONSENT_IDLE_MS = 120_000;
const MAX_FILE_GRANTS = 256;

interface FileConsent {
  /** A host-resolved path: reads follow links, writes resolve their parent. */
  path: string;
  tree: boolean;
  /** Keep approvals tied to the workspace location used when the user answered. */
  workspaceRoot: string;
}

interface FileGrant {
  readonly key: string;
  readonly path: string;
  readonly tree: boolean;
  expiresAt: number;
}

function covers(grant: FileGrant, target: string): boolean {
  const { sep } = filePathRules(grant.path);
  return (
    target === grant.path ||
    (grant.tree && target.startsWith(grant.path.endsWith(sep) ? grant.path : grant.path + sep))
  );
}

const forbidden = (message: string) => new RpcFailure(RpcErrorCode.Forbidden, message);

export class AgentGate {
  /**
   * When each agent ("device|workspace|tab") and each device ("device")
   * asked lately, within the last minute.
   */
  private readonly recent = new Map<string, number[]>();
  /** The prompts waiting on the user, by the device whose agent asked. */
  private readonly prompting = new Map<string, number>();
  /** "device|its workspace>this workspace" pairs the user allowed until restart. */
  private readonly allowed = new Set<string>();

  private fileGrants: FileGrant[] = [];

  constructor(private readonly deps: AgentGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A read of an agent's (since 0.12.0) goes ahead, unasked, unless agents are turned down. */
  checkRead(): void {
    if (this.deps.policy() === "deny") {
      throw forbidden("requests from agents are off there (Settings › Remote)");
    }
  }

  /** Resolves when the request may go ahead; a RpcFailure saying why when not. */
  async check(services: CliServices, request: AgentRequest): Promise<string | undefined> {
    const { device, params } = request;
    const { from } = params;
    // The device's share first: its agents' names are its to make up.
    this.count(
      device.id,
      MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE,
      "too many messages from that device",
    );
    this.count(
      `${device.id}|${from.workspaceId}|${from.tabId}`,
      MAX_AGENT_REQUESTS_PER_MINUTE,
      "too many messages from that agent",
    );
    refuseBeyondAsked(request);
    if (this.deps.policy() === "deny")
      throw forbidden("control by agents is off there (Settings › Remote)");
    const { approval, expectedMode } = await operationApproval(services, request);
    await this.consent(services, request, undefined, approval);
    return expectedMode;
  }

  /** File transfers use the same prompt and session approvals as other controls. */
  async checkFile(services: CliServices, request: AgentRequest, scope: FileConsent): Promise<void> {
    const { device, method, params } = request;
    const reading =
      method === "files.read" || (method === "files.list" && params.writeTarget !== true);
    const transferId = params.transferId;
    // Writing one file takes one approval at begin. A recursive copy starts
    // with mkdir and may reuse that approval for the directory's children.
    if (!reading && typeof transferId !== "string") {
      await this.consent(services, request, scope);
      return;
    }
    const key = JSON.stringify([
      device.id,
      params.from.workspaceId,
      params.from.tabId,
      params.workspaceId,
      scope.workspaceRoot,
      reading,
      params.anywhere === true,
      transferId,
    ]);
    this.checkRead();
    const now = this.now();
    this.fileGrants = this.fileGrants.filter((grant) => grant.expiresAt > now);
    const grant = this.fileGrants.find(
      (entry) =>
        entry.key === key &&
        covers(entry, scope.path) &&
        (entry.tree || !scope.tree) &&
        (method !== "files.write.begin" || entry.path !== scope.path),
    );
    if (grant) {
      grant.expiresAt = now + FILE_CONSENT_IDLE_MS;
      return;
    }
    const answer = await this.consent(services, request, scope);
    if (answer === "once" && (reading || scope.tree)) {
      if (this.fileGrants.length >= MAX_FILE_GRANTS) this.fileGrants.shift();
      this.fileGrants.push({
        key,
        path: scope.path,
        tree: scope.tree,
        expiresAt: this.now() + FILE_CONSENT_IDLE_MS,
      });
    }
  }

  private async consent(
    services: CliServices,
    request: AgentRequest,
    scope?: FileConsent,
    approval: Approval = "policy",
  ) {
    const { device, params } = request;
    const { from } = params;
    const policy = this.deps.policy();
    if (policy === "deny") throw forbidden("control by agents is off there (Settings › Remote)");
    if (policy === "allow" && approval === "policy") return;
    const eachTime = approval === "once";
    const pair = JSON.stringify([device.id, from.workspaceId, params.workspaceId]);
    if (!eachTime && this.allowed.has(pair)) return;
    const change = await changeOf(services, request, scope, approval);
    const waiting = this.prompting.get(device.id) ?? 0;
    if (waiting >= MAX_PENDING_PROMPTS_PER_DEVICE) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "the user there has that device's agents' prompts waiting already: try again once they answer",
      );
    }
    this.prompting.set(device.id, waiting + 1);
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
          fromDeviceId: device.id,
          ...(from.name ? { fromName: from.name } : {}),
        },
        AGENT_CONSENT_MS + 10_000,
      )
      .catch((error: unknown) => {
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        const left = (this.prompting.get(device.id) ?? 1) - 1;
        if (left > 0) this.prompting.set(device.id, left);
        else this.prompting.delete(device.id);
      });
    if (answer === "once" || (answer === "session" && !eachTime)) {
      this.checkRead();
      if (answer === "session") this.allowed.add(pair);
      return answer;
    }
    throw forbidden(
      answer === "timeout"
        ? "the user there did not answer in time; nothing was done"
        : "the user there did not allow it",
    );
  }

  /** Counts a request of `key`; Unavailable, saying `why`, past the minute's `max`. */
  private count(key: string, max: number, why: string): void {
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (times.length >= max) {
      this.recent.set(key, times);
      throw new RpcFailure(RpcErrorCode.Unavailable, why);
    }
    times.push(now);
    this.recent.set(key, times);
    // Agents that stopped asking are let go of.
    for (const [k, list] of this.recent) {
      if (list.every((at) => now - at >= MINUTE_MS)) this.recent.delete(k);
    }
  }
}

/**
 * An agent answers a permission request only as it was asked, and once:
 * the consent prompt shows the request as it came, so a changed one
 * (updatedInput) would run what the user never saw, and a rule kept for
 * good (always, allowAlways) or a mode (a plan's planMode) would outlast
 * the one answer they allowed.
 */
function refuseBeyondAsked({ method, params }: AgentRequest): void {
  const changed =
    method === "chat.answer" &&
    (params.updatedInput !== undefined ||
      params.planMode !== undefined ||
      (Array.isArray(params.always) && params.always.length > 0));
  if (changed || (method === "terminal.answer" && params.decision === "allowAlways")) {
    throw forbidden("an agent may answer a request only as it was asked, and only once");
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
    ...(typeof from.waits === "boolean" ? { waits: from.waits } : {}),
  };
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

async function tabTitle(services: CliServices, workspaceId: string, tabId: string) {
  const { tabs } = await services.ui("tabs.list", { workspaceId }).catch(() => ({ tabs: [] }));
  return tabs.find((t) => t.id === tabId)?.title ?? tabId.slice(0, 8);
}

type Approval = "policy" | "session" | "once";

async function operationApproval(
  services: CliServices,
  { method, params }: AgentRequest,
): Promise<{ approval: Approval; expectedMode?: string }> {
  if (
    method === "notes.voiceNames.delete" ||
    (method === "settings.instructions.set" && params.layer !== "workspace")
  )
    return { approval: "once" };
  if (method === "chat.rewind" || method === "chat.profile") return { approval: "session" };
  if (typeof params.permissionMode === "string") {
    if (method === "chat.new") {
      const agent = params.agent === "codex" ? "codex" : "claude";
      const next = chatModeNamed(agent, params.permissionMode);
      if (next && loosens(agent, CHAT_MODES[agent].fallback, next)) return { approval: "session" };
    }
    if (method === "chat.configure" && params.tabId) {
      const current = await services.ui("chat.settings", {
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        settings: {},
      });
      const next = chatModeNamed(current.agent, params.permissionMode);
      return {
        approval: next && loosens(current.agent, current.mode, next) ? "session" : "policy",
        expectedMode: current.mode,
      };
    }
  }
  return { approval: "policy" };
}

/** What the user is asked to let the agent do, as the consent prompt says it. */
async function changeOf(
  services: CliServices,
  { method, params }: AgentRequest,
  scope?: FileConsent,
  approval: Approval = "policy",
): Promise<CliChange> {
  const eachTime = approval === "once";
  const { workspaceId, tabId = "" } = params;
  const title = () => tabTitle(services, workspaceId, tabId);
  switch (method) {
    case "files.write.begin":
      return {
        kind: "fileWrite",
        detail: scope?.path ?? String(params.path),
        body: `${String(params.size)} B`,
        terminal: params.anywhere === true,
      };
    case "files.mkdir":
      return {
        kind: scope?.tree ? "fileWriteTree" : "fileMkdir",
        detail: scope?.path ?? String(params.path),
        terminal: params.anywhere === true,
      };
    case "files.list":
    case "files.read":
      return {
        kind:
          params.writeTarget === true ? "fileWriteTree" : scope?.tree ? "fileReadTree" : "fileRead",
        detail: scope?.path ?? String(params.path),
        terminal: true,
      };
    case "chat.send":
      return { kind: "chatInput", detail: await title(), body: String(params.text) };
    case "chat.unqueue":
    case "chat.withdraw":
      return { kind: "chatInput", detail: await title() };
    case "chat.editHeld":
      return { kind: "chatInput", detail: await title(), body: String(params.text) };
    case "chat.attach":
      return {
        kind: "chatInput",
        detail: await title(),
        body: `Attach a ${String(params.mediaType)} image`,
      };
    case "chat.command":
      return {
        kind: "chatInput",
        detail: await title(),
        body: [`/${String(params.name).replace(/^\//, "")}`, params.args].filter(Boolean).join(" "),
      };
    case "chat.instructions.set":
      return { kind: "chatSettings", detail: await title(), body: String(params.text) };
    case "chat.remoteControl":
      return {
        kind: params.enabled === true ? "chatRemoteControlOn" : "chatRemoteControlOff",
        detail: await title(),
      };
    case "chat.rename":
    case "terminal.rename":
      return {
        kind: "tabRename",
        detail: await title(),
        body: String(params.title),
        ...(method === "terminal.rename" ? { terminal: true } : {}),
      };
    case "chat.fork":
      return { kind: "chatFork", detail: await title() };
    case "chat.resume":
      return {
        kind: "chatNew",
        detail: tabId ? await title() : (AGENT_NAMES[String(params.agent)] ?? "Chat"),
      };
    case "chat.rewind": {
      const target = { workspaceId, tabId, itemKey: String(params.itemKey) };
      const preview =
        params.files === true ? await services.ui("chat.rewindPreview", target) : undefined;
      if (preview && !preview.canRewind)
        throw new RpcFailure(
          RpcErrorCode.InvalidParams,
          preview.error || "the files cannot be rewound",
        );
      return {
        kind: params.files === true ? "chatRewindFiles" : "chatRewind",
        detail: await title(),
        ...(preview ? { body: preview.filesChanged.join("\n") } : {}),
        ...(eachTime ? { eachTime: true } : {}),
      };
    }
    case "chat.profile": {
      const profiles = await services.ui("chat.profile", {
        workspaceId,
        tabId,
        profile: String(params.profile),
        fresh: params.fresh === true,
        dryRun: true,
      });
      return {
        kind: params.fresh === true ? "chatProfileNew" : "chatProfile",
        detail: `"${await title()}" (${profiles.from} → ${profiles.to})`,
      };
    }
    case "settings.instructions.set":
      return {
        kind: "instructionsEdit",
        detail:
          params.layer === "workspace"
            ? services.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.name
            : (AGENT_NAMES[String(params.layer)] ?? "Shared"),
        body: String(params.text || "Clear this layer"),
        ...(eachTime ? { eachTime: true } : {}),
      };
    case "notes.speakers": {
      const action = params.change as Record<string, unknown>;
      return {
        kind: "noteSpeakers",
        detail:
          (await findNote(services, workspaceId, String(params.note))).title.trim() ||
          "Untitled note",
        body: Object.values(action).join(" "),
      };
    }
    case "notes.voiceSuggestions.change": {
      const action = params.action as Record<string, unknown>;
      return {
        kind: "noteSpeakers",
        detail:
          (await findNote(services, workspaceId, String(params.note))).title.trim() ||
          "Untitled note",
        body: [action.op, action.speaker, action.name].join(" "),
      };
    }
    case "notes.voiceNames.delete":
      return {
        kind: "voiceNamesDelete",
        detail: String(params.name ?? "all remembered names"),
        ...(eachTime ? { eachTime: true } : {}),
      };
    case "browser.devtools":
      return {
        kind: "browserControl",
        detail: await title(),
        body: "Toggle browser developer tools",
      };
    case "layout.change":
    case "agentView.change": {
      const action = params.change as { op: string; path?: string };
      return {
        kind: method === "layout.change" && action.op === "close" ? "groupClose" : "layout",
        detail: action.path ?? services.listWorkspaces().find((w) => w.id === workspaceId)?.name,
      };
    }
    case "worktree.new": {
      const start = params.start as { command?: string } | undefined;
      return {
        kind: "worktreeNew",
        detail: String(params.name),
        body: [start?.command, params.prompt].filter(Boolean).join("\n\n"),
        ...(start?.command ? { terminal: true } : {}),
      };
    }
    case "worktree.remove":
      return {
        kind: params.deleteBranch === true ? "worktreeRemoveBranch" : "worktreeRemove",
        detail:
          services.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.name ??
          "Worktree",
        ...(params.force === true ? { body: "Discard uncommitted changes" } : {}),
      };
    case "chat.new":
      if (approval === "session")
        return {
          kind: "chatMode",
          detail: `${AGENT_NAMES[String(params.agent)]} (${String(params.permissionMode)})`,
          ...(typeof params.prompt === "string" && params.prompt ? { body: params.prompt } : {}),
        };
      return {
        kind: "chatNew",
        detail: AGENT_NAMES[String(params.agent)] ?? String(params.agent),
        ...(typeof params.prompt === "string" && params.prompt.trim() !== ""
          ? { body: params.prompt }
          : {}),
      };
    case "chat.interrupt":
      return { kind: "chatInterrupt", detail: await title() };
    case "chat.configure":
      return typeof params.permissionMode === "string"
        ? {
            kind: "chatMode",
            detail: `"${await title()}" (${params.permissionMode})`,
            ...(eachTime ? { eachTime } : {}),
          }
        : { kind: "chatSettings", detail: await title() };
    case "chat.close":
      return { kind: "tabClose", detail: await title() };
    case "terminal.close":
      return { kind: "tabClose", detail: await title(), terminal: true };
    case "terminal.open":
      return {
        kind: "terminalNew",
        ...(typeof params.command === "string" ? { body: params.command } : {}),
      };
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
