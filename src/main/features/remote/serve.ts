import {
  type AgentSender,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
} from "../../../../packages/remote-protocol/src";
import {
  InstructionTextSchema,
  workspaceInstructionTarget,
} from "../../../shared/chat/instructions";
import type { RelaySender } from "../../../shared/chat/relay";
import { type CliUiOps, PROFILE_USAGE_REFRESH_TIMEOUT_MS } from "../../../shared/cli/ui";
import type { CliServices } from "../cli/context";
import { openerOf } from "../cli/sender";
import { type AgentRequest, lifetimeOf, relaySenderOf } from "./agent-gate";
import { Attachments } from "./attachments";
import { answerConsent } from "./consents";
import { isFileTransferMethod } from "./file-io";
import { FileWrites } from "./file-writes";
import { listFolders } from "./folders";
import { gitDiff, gitLog, gitShow, gitStatus } from "./git";
import {
  attachToNote,
  boundedNoteResult,
  findNote,
  listNotes,
  noteTranscript,
  PhotoQuota,
  readNote,
} from "./notes";
import { RpcFailure } from "./room";
import {
  answerChat,
  attachToChat,
  backgroundChatTool,
  beginUpload,
  changeChatProfile,
  chatCommands,
  chatFileSuggestions,
  chatImage,
  chatSettings,
  checkChatSignIn,
  closeChat,
  configureChat,
  editHeldChat,
  forkChat,
  hurryChat,
  interruptChat,
  listProfiles,
  newChat,
  renameChat,
  restartChat,
  resumeChat,
  rewindChat,
  runChatCommand,
  sendChat,
  setChatRemoteControl,
  stopChatRun,
  stopChatTask,
  unqueueChat,
  withdrawChat,
  workChatConfig,
  workChatMcp,
} from "./serving/chat";
import {
  chatOriginal,
  chatPanel,
  chatRun,
  chatRuns,
  chatTool,
  listHistory,
  peekChat,
  previewChatRewind,
  readChat,
  readChatRun,
  readEvents,
} from "./serving/chat-details";
import { fitsAsResult, tabOf, unavailable, workspaceOf } from "./serving/common";
import { serveFileDestination, serveFileRead, serveFileSearch } from "./serving/files";
import { changeAgentView, changeLayout, readAgentView, readLayout } from "./serving/layout";
import { ReadBudget } from "./serving/read-budget";
import { holdReceipts, reorderSessions, serveSessionsList } from "./serving/sessions";
import { readTerminal } from "./serving/terminal";
import type { RemoteServeOptions, RemoteServeRequest } from "./serving/types";
import { createWorkspace } from "./serving/workspaces";
import {
  answerTerminal,
  closeTerminal,
  inputTerminal,
  openTerminal,
  renameTerminal,
  terminalShells,
} from "./terminal-control";
import { Uploads } from "./uploads";
import { waitOnChat, waitOnTerminalFor } from "./waits";

export {
  answerChat,
  attachToChat,
  backgroundChatTool,
  beginUpload,
  changeChatProfile,
  chatCommands,
  chatFileSuggestions,
  chatImage,
  chatSettings,
  checkChatSignIn,
  closeChat,
  configureChat,
  editHeldChat,
  forkChat,
  hurryChat,
  interruptChat,
  listProfiles,
  newChat,
  renameChat,
  restartChat,
  resumeChat,
  rewindChat,
  runChatCommand,
  sendChat,
  setChatRemoteControl,
  settingsOf,
  stopChatRun,
  stopChatTask,
  unqueueChat,
  withdrawChat,
  workChatConfig,
  workChatMcp,
} from "./serving/chat";
export {
  chatOriginal,
  chatPanel,
  chatRun,
  chatRuns,
  chatTool,
  DEFAULT_READ_ITEMS,
  fitOversizeCodexChildren,
  fitPage,
  listHistory,
  previewChatRewind,
  readChat,
  readChatRun,
  readEvents,
  runDetailOf,
  runRowOf,
} from "./serving/chat-details";
export {
  fitsAsResult,
  SERVES,
  servesWith,
  tabOf,
  unavailable,
  workspaceOf,
} from "./serving/common";
export { listSessions, sessionAgents } from "./serving/sessions";
export { DEFAULT_TERMINAL_LINES, readTerminal } from "./serving/terminal";
export { createWorkspace } from "./serving/workspaces";

const AGENT_READS: ReadonlySet<string> = new Set([
  "sessions.list",
  "chat.read",
  "chat.peek",
  "chat.runRead",
  "chat.wait",
  "terminal.read",
  "terminal.wait",
  "events.read",
  "chat.commands",
  "chat.panel",
  "chat.tool",
  "chat.fileSuggestions",
  "chat.instructions",
  "settings.instructions",
  "chat.entryItem",
  "chat.rewindPreview",
  "chat.image",
  "history.list",
  "profiles.list",
  "profiles.usage",
  "terminal.shells",
  "notes.list",
  "notes.read",
  "notes.transcript",
  "notes.voiceNames.list",
  "notes.voiceSuggestions.list",
  "layout.get",
  "agentView.get",
  "browser.permissions",
]);

const READ_DEADLINES: Partial<Record<RpcMethod, number>> = {
  "chat.commands": 12_000,
  "chat.panel": 12_000,
  "chat.tool": 12_000,
  "chat.fileSuggestions": 12_000,
  "chat.instructions": 12_000,
  "settings.instructions": 12_000,
  "chat.entryItem": 12_000,
  "chat.rewindPreview": 12_000,
  "chat.image": 12_000,
  "history.list": 12_000,
  "profiles.list": 12_000,
  "profiles.usage": 12_000,
  "terminal.shells": 12_000,
  "notes.list": 12_000,
  "notes.read": 12_000,
  "notes.transcript": 12_000,
  "notes.voiceNames.list": 12_000,
  "notes.voiceSuggestions.list": 5 * 60_000,
  "layout.get": 12_000,
  "agentView.get": 12_000,
  "browser.permissions": 12_000,
};

export function serveWith(services: () => CliServices | null, watches: RemoteServeOptions = {}) {
  const { chats, sessions, terminals, git } = watches;
  const attachments = watches.attachments ?? new Attachments();
  const uploads = watches.uploads ?? new Uploads(attachments);
  const fileWrites = watches.fileWrites ?? new FileWrites();
  const photoQuota = watches.photoQuota ?? new PhotoQuota();
  const searching = new Map<string, number>();
  async function dispatch(services: CliServices, request: RemoteServeRequest) {
    const { from, method } = request;
    let { params } = request;
    let s = services;
    if (sessions && method === "sessions.watch") return sessions.watch(from, request.id);
    if (sessions && method === "sessions.unwatch") {
      return sessions.unwatch(from, params as RpcParams<"sessions.unwatch">);
    }
    if (chats && method === "chat.watch") {
      return chats.watch(from, params as RpcParams<"chat.watch">);
    }
    if (chats && method === "chat.unwatch") {
      return chats.unwatch(from, params as RpcParams<"chat.unwatch">);
    }
    if (terminals && method === "terminal.watch") {
      return terminals.watch(from, params as RpcParams<"terminal.watch">);
    }
    if (terminals && method === "terminal.unwatch") {
      return terminals.unwatch(from, params as RpcParams<"terminal.unwatch">);
    }
    const by = (params as { from?: AgentSender } | undefined)?.from;
    if (by && request.signal) s = askingWhileWanted(s, request.signal);
    if (
      (method === "sessions.reorder" ||
        method === "sessions.markSeen" ||
        method === "system.stats") &&
      by !== undefined
    ) {
      throw new RpcFailure(RpcErrorCode.Forbidden, `${method} is not taken from agents`);
    }
    let relay: RelaySender | undefined;
    let expectedMode: string | undefined;
    if (by && !watches.agents) {
      throw new RpcFailure(RpcErrorCode.Forbidden, "agents' requests are not taken here");
    }
    const agentOnly =
      method === "settings.instructions" ||
      method === "settings.instructions.set" ||
      method === "notes.voiceNames.delete";
    if (agentOnly && !by)
      throw new RpcFailure(RpcErrorCode.Forbidden, "an agent sender is required");
    if (method === "settings.instructions.set") {
      const edit = params as RpcParams<"settings.instructions.set">;
      if (!InstructionTextSchema.safeParse(edit.text).success)
        throw new RpcFailure(RpcErrorCode.InvalidParams, "invalid persistent instruction text");
      if (edit.layer === "workspace") {
        watches.agents?.checkRead();
        const workspaces = s.listWorkspaces();
        const workspace = workspaces.find(({ id }) => id === edit.workspaceId);
        if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        const target = workspaceInstructionTarget(workspace, workspaces);
        if (!target) throw new RpcFailure(RpcErrorCode.NotFound, "no parent workspace");
        params = { ...edit, workspaceId: target.id };
      }
    }
    const checkInHandler = isFileTransferMethod(method);
    const readOnly = AGENT_READS.has(method);
    if (by && (readOnly || checkInHandler)) watches.agents?.checkRead();
    if (by && watches.agents && !readOnly && !checkInHandler) {
      const device = { id: from, name: watches.deviceName?.(from) ?? from.slice(0, 8) };
      relay = relaySenderOf(by, device);
      expectedMode = await watches.agents.check(s, {
        device,
        method,
        params: params as AgentRequest["params"],
        ...lifetimeOf(request),
      });
    }
    const checkCurrent = () => {
      if (request.isCurrent?.() === false) {
        throw new RpcFailure(RpcErrorCode.Unavailable, "the requesting device left the room");
      }
      request.signal?.throwIfAborted();
    };
    if (by && !readOnly && !checkInHandler) {
      checkCurrent();
      const asking = s;
      s = {
        ...asking,
        ui: (op, args, timeoutMs) => {
          checkCurrent();
          return asking.ui(op, args, timeoutMs);
        },
        answerClaudeAsk: (...args) => {
          checkCurrent();
          return asking.answerClaudeAsk(...args);
        },
      };
    }
    const controls = watches.controls?.() ?? { chat: false, terminal: false };
    const openedBy = openerOf(relay);
    switch (request.method) {
      case "sessions.list":
        return serveSessionsList(s, git, watches.notes, from, controls, request.id);
      case "sessions.reorder":
        checkCurrent();
        return reorderSessions(s, params as RpcParams<"sessions.reorder">);
      case "sessions.markSeen": {
        checkCurrent();
        const receipt = params as RpcParams<"sessions.markSeen">;
        const held = holdReceipts(s, receipt.seen);
        try {
          const result = await s.ui("sessions.markSeen", receipt);
          held.taken();
          return result;
        } catch (error) {
          held.failed();
          return unavailable(error);
        }
      }
      case "notes.read":
        return readNote(s, request.params as RpcParams<"notes.read">);
      case "notes.transcript":
        return noteTranscript(s, request.params as RpcParams<"notes.transcript">);
      case "settings.instructions": {
        const { workspaceId, agent, profileId } = params as RpcParams<"settings.instructions">;
        if (!workspaceOf(s, workspaceId))
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        return s
          .ui("settings.instructions", { workspaceId, agent, ...(profileId ? { profileId } : {}) })
          .catch(unavailable);
      }
      case "settings.instructions.set": {
        const edit = params as RpcParams<"settings.instructions.set">;
        const { workspaceId, text } = edit;
        if (!workspaceOf(s, workspaceId))
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        const scope =
          edit.layer === "profile"
            ? { kind: "profile" as const, id: edit.profileId }
            : edit.layer === "all"
              ? { kind: "all" as const }
              : edit.layer === "workspace"
                ? { kind: "workspace" as const, id: workspaceId }
                : { kind: "agent" as const, agent: edit.layer };
        return s.ui("settings.instructions.set", { scope, text }).catch(unavailable);
      }
      case "notes.speakers": {
        const { workspaceId, note, recording, change } = params as RpcParams<"notes.speakers">;
        const { id } = await findNote(s, workspaceId, note);
        const result = await s
          .ui("note.speakers", { workspaceId, noteId: id, recording, change }, 5 * 60_000)
          .catch(unavailable);
        return { noteId: id, ...result };
      }
      case "notes.voiceSuggestions.list":
      case "notes.voiceSuggestions.change": {
        const { workspaceId, note, recording } = params as RpcParams<"notes.voiceSuggestions.list">;
        const { id } = await findNote(s, workspaceId, note);
        const action =
          method === "notes.voiceSuggestions.change"
            ? (params as RpcParams<"notes.voiceSuggestions.change">).action
            : { op: "list" as const };
        const result = await s
          .ui("note.voiceSuggestions", { workspaceId, noteId: id, recording, action }, 5 * 60_000)
          .catch(unavailable);
        return boundedNoteResult({ noteId: id, ...result });
      }
      case "notes.voiceNames.list":
        return boundedNoteResult(
          await s.ui("note.voiceNames", { action: { op: "list" } }).catch(unavailable),
        );
      case "notes.voiceNames.delete": {
        const { workspaceId, name } = params as RpcParams<"notes.voiceNames.delete">;
        if (!workspaceOf(s, workspaceId))
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        await s.ui("note.voiceNames", { action: { op: "delete", name } }).catch(unavailable);
        return {};
      }
      case "browser.permissions": {
        const { workspaceId } = params as RpcParams<"browser.permissions">;
        if (!workspaceOf(s, workspaceId))
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        const reply = await s.ui("browser.permissions", { workspaceId }).catch(unavailable);
        if (!fitsAsResult(reply))
          throw new RpcFailure(
            RpcErrorCode.Unavailable,
            "browser permission settings exceed one frame",
          );
        return reply;
      }
      case "browser.devtools": {
        const { workspaceId, tabId } = params as RpcParams<"browser.devtools">;
        await tabOf(s, workspaceId, tabId, ["browser"]);
        return s.ui("browser.devtools", { workspaceId, tabId }).catch(unavailable);
      }
      case "layout.get":
        return readLayout(s, (params as RpcParams<"layout.get">).workspaceId);
      case "layout.change":
        return changeLayout(s, params as RpcParams<"layout.change">, controls.terminal);
      case "agentView.get":
        return readAgentView(s);
      case "agentView.change":
        return changeAgentView(s, params as RpcParams<"agentView.change">, watches.files?.fs);
      case "worktree.new": {
        const { workspaceId, name, prompt, show, start } =
          request.params as RpcParams<"worktree.new">;
        const base = workspaceOf(s, workspaceId);
        if (!base || base.task)
          throw new RpcFailure(
            RpcErrorCode.InvalidParams,
            "choose the worktree's parent workspace",
          );
        if (start && "command" in start && start.command && !controls.terminal)
          throw new RpcFailure(
            RpcErrorCode.Forbidden,
            "a worktree command requires terminal control",
          );
        const created = await s
          .ui(
            "task.create",
            {
              parentId: workspaceId,
              name,
              prompt,
              show,
              ...(start ? { start } : {}),
              ...(relay && prompt.trim() ? { from: relay } : {}),
              ...(openedBy ? { openedBy } : {}),
            },
            5 * 60_000,
          )
          .catch(unavailable);
        if (
          created.tabId &&
          "command" in created.start &&
          created.start.command.trim() &&
          prompt.trim()
        )
          s.startedAgents.mark(
            { workspaceId: created.workspaceId, tabId: created.tabId },
            s.clock.now(),
          );
        return created;
      }
      case "worktree.remove": {
        const { workspaceId, force, deleteBranch } = request.params as RpcParams<"worktree.remove">;
        if (!workspaceOf(s, workspaceId)?.task)
          throw new RpcFailure(RpcErrorCode.InvalidParams, "choose a worktree");
        if (!(watches.controls?.() ?? controls).terminal) {
          const { tabs } = await s.ui("tabs.list", { workspaceId }).catch(unavailable);
          if (
            s.hasRunningTerminals?.(workspaceId) ||
            tabs.some((tab) => tab.type === "terminal" && !tab.dead && !tab.unstarted)
          ) {
            throw new RpcFailure(
              RpcErrorCode.Forbidden,
              "removing a worktree with running terminals requires terminal control",
            );
          }
        }
        return s
          .ui("task.remove", { taskId: workspaceId, force, deleteBranch }, 5 * 60_000)
          .catch(unavailable);
      }
      case "chat.entryItem": {
        const entry = request.params as RpcParams<"chat.entryItem">;
        const { workspaceId, tabId, i } = entry;
        await tabOf(s, workspaceId, tabId, ["claude", "codex"]);
        return s.ui("chat.entryItem", { workspaceId, tabId, i }).catch(unavailable);
      }
      case "chat.instructions.set": {
        const { workspaceId, tabId, text } = request.params as RpcParams<"chat.instructions.set">;
        if (!InstructionTextSchema.safeParse(text).success)
          throw new RpcFailure(RpcErrorCode.InvalidParams, "invalid session instruction text");
        await tabOf(s, workspaceId, tabId, ["claude", "codex"]);
        checkCurrent();
        const { instructions } = await s
          .ui("chat.instructions", { workspaceId, tabId, text })
          .catch(unavailable);
        return { instructions };
      }
      case "chat.instructions": {
        const { workspaceId, tabId } = request.params as RpcParams<"chat.instructions">;
        await tabOf(s, workspaceId, tabId, ["claude", "codex"]);
        return s.ui("chat.instructions", { workspaceId, tabId }).catch(unavailable);
      }
      case "notes.list":
      case "notes.attach": {
        const notes = watches.notes;
        if (!notes) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        if (request.method === "notes.list") {
          return listNotes(notes, request.params as RpcParams<"notes.list">);
        }
        photoQuota.take(from);
        return attachToNote(notes, request.params as RpcParams<"notes.attach">);
      }
      case "consent.answer":
        return answerConsent(
          s,
          { id: from, name: watches.deviceName?.(from) ?? from.slice(0, 8) },
          controls,
          request.params as RpcParams<"consent.answer">,
        );
      case "chat.read":
        return readChat(s, request.params as RpcParams<"chat.read">, from);
      case "chat.peek":
        return peekChat(s, request.params as RpcParams<"chat.peek">, from);
      case "terminal.read":
        return readTerminal(s, request.params as RpcParams<"terminal.read">, from);
      case "chat.send":
        return sendChat(
          s,
          request.params as RpcParams<"chat.send">,
          { device: from, attachments },
          relay,
        );
      case "files.write.begin":
      case "files.mkdir":
        return serveFileDestination(s, request, watches, fileWrites, checkCurrent, by);
      case "files.write.chunk":
        await fileWrites.chunk(from, request.params as RpcParams<"files.write.chunk">);
        return {};
      case "files.write.end":
        return fileWrites.end(from, request.params as RpcParams<"files.write.end">);
      case "files.write.abort":
        await fileWrites.abort(from, request.params as RpcParams<"files.write.abort">);
        return {};
      case "files.list":
      case "files.read":
        return serveFileRead(s, request, watches, checkCurrent, by);
      case "files.find":
      case "files.search":
        return serveFileSearch(s, request, watches, searching);
      case "system.stats": {
        if (!watches.files || !watches.stats) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, "system.stats is not served here");
        }
        const { workspaceId } = params as RpcParams<"system.stats">;
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        const stats = await watches.stats(workspaceId);
        if (!stats) throw new RpcFailure(RpcErrorCode.Unavailable, "the host cannot tell now");
        return stats;
      }
      case "git.status":
      case "git.diff":
      case "git.log":
      case "git.show": {
        const repositories = watches.repositories;
        if (!repositories) {
          throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
        }
        const { workspaceId } = request.params as { workspaceId: string };
        if (!workspaceOf(s, workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        if (request.method === "git.status") {
          return gitStatus(repositories, request.params as RpcParams<"git.status">);
        }
        if (request.method === "git.show") {
          return gitShow(repositories, request.params as RpcParams<"git.show">);
        }
        return request.method === "git.diff"
          ? gitDiff(repositories, request.params as RpcParams<"git.diff">)
          : gitLog(repositories, request.params as RpcParams<"git.log">);
      }
      case "chat.image":
        return chatImage(s, request.params as RpcParams<"chat.image">);
      case "chat.attach":
        return attachToChat(s, request.params as RpcParams<"chat.attach">, from, attachments);
      case "chat.upload.begin":
        return beginUpload(s, request.params as RpcParams<"chat.upload.begin">, from, uploads);
      case "chat.upload.chunk": {
        const { uploadId, offset, data } = request.params as RpcParams<"chat.upload.chunk">;
        uploads.chunk(from, uploadId, offset, data);
        return {};
      }
      case "chat.upload.end":
        return {
          attachmentId: uploads.end(
            from,
            (request.params as RpcParams<"chat.upload.end">).uploadId,
          ),
        };
      case "chat.answer":
        return answerChat(s, request.params as RpcParams<"chat.answer">);
      case "chat.interrupt":
        return interruptChat(s, request.params as RpcParams<"chat.interrupt">);
      case "chat.restart":
        return restartChat(s, request.params as RpcParams<"chat.restart">);
      case "chat.checkSignIn":
        return checkChatSignIn(s, request.params as RpcParams<"chat.checkSignIn">);
      case "chat.settings":
        return chatSettings(s, request.params as RpcParams<"chat.settings">);
      case "chat.configure":
        return configureChat(
          s,
          request.params as RpcParams<"chat.configure">,
          relay !== undefined,
          expectedMode,
        );
      case "chat.profile":
        return changeChatProfile(s, request.params as RpcParams<"chat.profile">);
      case "chat.commands":
        return chatCommands(s, request.params as RpcParams<"chat.commands">);
      case "chat.fileSuggestions":
        return chatFileSuggestions(s, request.params as RpcParams<"chat.fileSuggestions">);
      case "chat.command":
        return runChatCommand(
          s,
          request.params as RpcParams<"chat.command">,
          watches.folders,
          relay,
        );
      case "chat.new":
        return newChat(s, request.params as RpcParams<"chat.new">, watches.files?.fs, relay);
      case "chat.wait":
        return waitOnChat(s, request.params as RpcParams<"chat.wait">);
      case "terminal.wait":
        return waitOnTerminalFor(s, request.params as RpcParams<"terminal.wait">);
      case "events.read":
        return readEvents(s, request.params as RpcParams<"events.read">);
      case "profiles.list":
        return listProfiles(s, request.params as RpcParams<"profiles.list">);
      case "profiles.usage": {
        const { from: _, ...usage } = params as RpcParams<"profiles.usage">;
        if (usage.workspaceId !== undefined && !workspaceOf(s, usage.workspaceId)) {
          throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
        }
        return s.ui("chat.usage", usage).catch(unavailable);
      }
      case "chat.rename":
        return renameChat(s, request.params as RpcParams<"chat.rename">);
      case "chat.tool":
        return chatTool(s, request.params as RpcParams<"chat.tool">);
      case "chat.original":
        return chatOriginal(s, request.params as RpcParams<"chat.original">);
      case "chat.panel":
        return chatPanel(s, request.params as RpcParams<"chat.panel">);
      case "chat.stopTask":
        return stopChatTask(s, request.params as RpcParams<"chat.stopTask">);
      case "chat.runs":
        return chatRuns(s, request.params as RpcParams<"chat.runs">);
      case "chat.run":
        return chatRun(s, request.params as RpcParams<"chat.run">);
      case "chat.runRead":
        return readChatRun(s, request.params as RpcParams<"chat.runRead">, from);
      case "chat.stopRun":
        return stopChatRun(s, request.params as RpcParams<"chat.stopRun">);
      case "chat.rewindPreview":
        return previewChatRewind(s, request.params as RpcParams<"chat.rewindPreview">);
      case "chat.rewind":
        return rewindChat(s, request.params as RpcParams<"chat.rewind">);
      case "chat.fork":
        return forkChat(s, request.params as RpcParams<"chat.fork">, openedBy);
      case "chat.background":
        return backgroundChatTool(s, request.params as RpcParams<"chat.background">);
      case "chat.unqueue":
        return unqueueChat(s, request.params as RpcParams<"chat.unqueue">);
      case "chat.editHeld":
        return editHeldChat(s, request.params as RpcParams<"chat.editHeld">, from, relay);
      case "chat.withdraw":
        return withdrawChat(s, request.params as RpcParams<"chat.withdraw">);
      case "chat.hurry":
        return hurryChat(s, request.params as RpcParams<"chat.hurry">);
      case "folders.list":
        return listFolders(request.params as RpcParams<"folders.list">, watches.folders);
      case "workspace.create":
        return createWorkspace(
          s,
          request.params as RpcParams<"workspace.create">,
          watches.deviceName?.(from),
          watches.folders,
        );
      case "chat.remoteControl":
        return setChatRemoteControl(s, request.params as RpcParams<"chat.remoteControl">);
      case "chat.mcp":
        return workChatMcp(s, request.params as RpcParams<"chat.mcp">);
      case "chat.config":
        return workChatConfig(s, request.params as RpcParams<"chat.config">);
      case "history.list":
        return listHistory(s, request.params as RpcParams<"history.list">);
      case "chat.resume":
        return resumeChat(s, request.params as RpcParams<"chat.resume">, openedBy);
      case "chat.close":
        return closeChat(s, request.params as RpcParams<"chat.close">);
      case "terminal.input":
        return inputTerminal(s, request.params as RpcParams<"terminal.input">);
      case "terminal.shells":
        return terminalShells(s, request.params as RpcParams<"terminal.shells">);
      case "terminal.open":
        return openTerminal(
          s,
          request.params as RpcParams<"terminal.open">,
          watches.files?.fs,
          openedBy,
        );
      case "terminal.rename":
        return renameTerminal(s, request.params as RpcParams<"terminal.rename">);
      case "terminal.close":
        return closeTerminal(s, request.params as RpcParams<"terminal.close">);
      case "terminal.answer":
        return answerTerminal(s, request.params as RpcParams<"terminal.answer">);
      default:
        throw new RpcFailure(RpcErrorCode.MethodNotFound, `${request.method} is not served yet`);
    }
  }

  return async (request: RemoteServeRequest) => {
    const s = services();
    if (!s) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
    const timeout =
      request.method === "profiles.usage" && (request.params as RpcParams<"profiles.usage">).refresh
        ? PROFILE_USAGE_REFRESH_TIMEOUT_MS
        : READ_DEADLINES[request.method];
    if (timeout === undefined) return dispatch(s, request);
    const budget = new ReadBudget(s, request.method, request.from, timeout);
    const reader: CliServices = {
      ...s,
      ui: (op, args, ms) => budget.ui(op, args, ms ?? (op === "tabs.list" ? 2_000 : timeout)),
    };
    return budget.run(() => dispatch(reader, request));
  };
}

export { DEFAULT_EVENTS } from "./serving/chat-details";
export { MAX_SEARCHES_PER_DEVICE } from "./serving/files";
export type { WorkspaceGit } from "./serving/sessions";

function askingWhileWanted(services: CliServices, signal: AbortSignal): CliServices {
  return {
    ...services,
    ui: (op, args, timeoutMs) =>
      op === "consent.ask"
        ? (services.consents.ask(
            args as CliUiOps["consent.ask"]["args"],
            timeoutMs,
            signal,
          ) as Promise<CliUiOps[typeof op]["result"]>)
        : services.ui(op, args, timeoutMs),
  };
}
