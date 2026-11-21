/**
 * The nexus CLI's requests for Claude and Codex tabs: open one with a
 * message, tell where one stands, read its conversation or one tool call of
 * it, send it a message, answer its permission request, stop its turn, set
 * its model, effort and permission mode.
 * A tab not shown since the app started is opened first, as showing it
 * would: its program's log is read, and the program started when it is
 * gone.
 */

import i18next from "i18next";
import {
  isDefaultProfileId,
  portableProfileDir,
  profileOf,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import {
  mergeAgentInstructions,
  persistentInstructionLayers,
} from "../../../shared/chat/instructions";
import type { CliChatInfo, CliChatSettings, CliLimitResume, CliUiOp } from "../../../shared/cli/ui";
import { sameFolder } from "../../../shared/fs/drive-path";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { LimitResume } from "../../../shared/types/layout";
import { toolSummary } from "../../components/chat/tool-row";
import { ipcCallResult } from "../../ipc/client";
import { chatPropsWithProfile } from "../../state/operations/tabs";
import {
  saveSessionInstructions,
  useAgentInstructionsStore,
} from "../../state/stores/agent-instructions";
import {
  defaultFolderLabel,
  resolveWorkspaceProfile,
  tildePath,
  useAgentProfilesStore,
} from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  type AgentTabController,
  agentInstructionTarget,
  agentTabController,
} from "../chat/agent-tab";
import { conversationMarkdown } from "../chat/app-commands";
import type { ForkPoint } from "../chat/claude/controller";
import { borrowedClaudeModels, useClaudeModelCatalog } from "../chat/claude/model-catalog";
import { firstVersionOf } from "../chat/claude/versions";
import { CodexConfigRefusal } from "../chat/codex/config";
import { CodexReplyError } from "../chat/codex/controller";
import { fileMention } from "../chat/composer-input";
import { type ChatItem, type ChatModel, isWaiting, type UserItem } from "../chat/model";
import type { ModelPickerContext } from "../chat/model-picker";
import { jobOutputFile, jobsOf, outsideLinksOf } from "../chat/panel";
import { scopesOf } from "../chat/permission-scopes";
import { planUsageKeyFor } from "../chat/plan-usage";
import { sameProfile } from "../chat/profile-moves";
import { relayedOf } from "../chat/relayed";
import { chatKey, useChatStore } from "../chat/store";
import {
  sendFirstMessage,
  sendToAgentTab,
  sendUnseen,
  submissionAt,
} from "../chat/transport/submission";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { chatCommandsOf, runRemoteCommand } from "../remote/chat-commands";
import { ConfigRefusal, chatConfigOf, configSetOf } from "../remote/chat-config";
import { imageOf, readChatImage } from "../remote/chat-image";
import { originalOf } from "../remote/chat-original";
import {
  type ChatSource,
  chatPageOf,
  conversationOf,
  pageWithSubagents,
  unreadSubagentsOf,
  viewToolOf,
} from "../remote/chat-page";
import { chatPanelOf } from "../remote/chat-panel";
import { eachTimeItCan, startChatWatch, stopChatWatch, tabSource } from "../remote/chat-watch";
import {
  claudeSessions,
  codexThreads,
  pastSessionsOf,
  peerCodexThreads,
  tabWithSession,
} from "../remote/history";
import { cliProfileName } from "../remote/profile-name";
import { type ChatSettingsPlan, chatChoicesOf, planChatSettings } from "./chat-settings";
import {
  type ChatTabExtras,
  chatEntriesOf,
  chatInfoOf,
  chatItemIndexOf,
  chatSubmissionInfo,
  chatToolOf,
  pageEntriesOf,
} from "./chat-view";
import { type CliUiHandler, UiRequestError } from "./handler";
import { openTab } from "./placement";
import { profileUsage } from "./profile-usage";

type ChatOp = Extract<CliUiOp, `chat.${string}`>;

/** Whether the tab's conversation was opened since the app started. */
function opened(workspaceId: string, tabId: string): boolean {
  return useChatStore.getState().tabs[chatKey(workspaceId, tabId)] !== undefined;
}

async function openedTab(
  workspaceId: string,
  tabId: string,
  fullTranscript = false,
): Promise<AgentTabController> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
  const cold = !opened(workspaceId, tabId);
  if (target.agent === "claude" && fullTranscript) await target.controller.openToRead(cold);
  else if (cold) await target.controller.open();
  return target;
}

/**
 * The tab, opened as far as reading it needs: a Claude tab's transcript
 * shown, its program perhaps still starting (another device watching a
 * chat not open here sees it at once); a Codex tab's thread, which comes
 * with its program.
 */
async function readableTab(workspaceId: string, tabId: string): Promise<AgentTabController> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
  if (target.agent === "claude") await target.controller.openToRead();
  else if (!opened(workspaceId, tabId)) await target.controller.open();
  return target;
}

/**
 * Reads the messages of subagents the tab has none of (unreadSubagentsOf),
 * as a conversation read from its transcript has them: Claude Code keeps
 * them apart. The device's watch sends them once read; a page read again
 * has them. Done once all are read, or found nowhere.
 */
function readSubagents(target: AgentTabController, toolUseIds: readonly string[]): Promise<void> {
  if (target.agent !== "claude" || toolUseIds.length === 0) return Promise.resolve();
  return Promise.all(toolUseIds.map((id) => target.controller.loadSubagent(id))).then(
    () => {},
    () => {},
  );
}

/** The workspace's folder, where its past conversations ran. */
function workspaceRoot(workspaceId: string): string {
  const root = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath;
  if (!root) throw new UiRequestError("no such workspace");
  return root;
}

/** The tab's props: a Claude or Codex tab's; null when it is gone. */
function chatPropsOf(workspaceId: string, tabId: string) {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  return tab?.type === "claude" || tab?.type === "codex" ? tab.props : null;
}

/** The profile the tab runs with, by name, where its agent has more than the default. */
function profileShown(workspaceId: string, tabId: string, agent: ChatAgent): string | undefined {
  const config = useAgentProfilesStore.getState().config;
  if (profilesOf(config, agent).length < 2) return undefined;
  const props = chatPropsOf(workspaceId, tabId);
  return cliProfileName(profileOf(config, agent, props?.profileId));
}

function infoOf(
  workspaceId: string,
  tabId: string,
  { agent }: AgentTabController,
  includeWaitingId?: boolean,
) {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  const info = chatInfoOf(agent, chat, sendUnseen(workspaceId, tabId));
  const waitingId = includeWaitingId && info.waiting && chat?.model.permissions[0]?.requestId;
  return { ...withProfile(workspaceId, tabId, info), ...(waitingId ? { waitingId } : {}) };
}

/**
 * A Claude tab's MCP servers, asked once of a program that runs when it has
 * none yet: the tab asks as its panel opens them, and another computer's
 * panel shows them as the answer comes.
 */
function askMcp(workspaceId: string, tabId: string, target: AgentTabController): void {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  if (target.agent === "claude" && chat && !chat.model.mcp) {
    target.controller.refreshPanel(["mcp"]);
  }
}

/**
 * The info with what the tab keeps of its own: its profile, its folder when
 * not the workspace's, and going on after the usage limit, while no turn runs.
 */
function withProfile(workspaceId: string, tabId: string, info: CliChatInfo): CliChatInfo {
  const profile = profileShown(workspaceId, tabId, info.agent);
  const props = chatPropsOf(workspaceId, tabId);
  const cwd = props?.cwd;
  const root = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const own = cwd && root && !sameFolder(cwd, root);
  const limitResume = info.state === "working" ? undefined : cliLimitResume(props?.limitResume);
  return {
    ...info,
    ...(profile ? { profile } : {}),
    ...(own ? { cwd } : {}),
    ...(limitResume ? { limitResume } : {}),
  };
}

/** A tab's going on after the usage limit as the CLI tells it; none once its message went. */
function cliLimitResume(record: LimitResume | undefined): CliLimitResume | undefined {
  if (!record || record.state === "sent") return undefined;
  return {
    state: record.state,
    ...(record.at !== undefined ? { at: record.at } : {}),
    ...(record.resetsAt !== undefined ? { resetsAt: record.resetsAt } : {}),
    ...(record.tries > 0 ? { tries: record.tries } : {}),
  };
}

/** What the tab keeps beside its conversation, as a read tells it: who sent what, where it moved. */
function extrasOf(workspaceId: string, tabId: string, agent: ChatAgent): ChatTabExtras {
  const props = chatPropsOf(workspaceId, tabId);
  if (!props) return {};
  const config = useAgentProfilesStore.getState().config;
  const moves = props.moves?.map((move) => ({
    after: move.after,
    profile: cliProfileName(profileOf(config, agent, move.profileId)),
  }));
  const relayed = relayedOf(props);
  return {
    ...(relayed ? { relayed } : {}),
    ...(moves ? { moves } : {}),
  };
}

/** A Claude tab, opened as reading it needs. */
async function claudeTab(workspaceId: string, tabId: string, opened = false) {
  const target = await (opened ? openedTab(workspaceId, tabId) : readableTab(workspaceId, tabId));
  if (target.agent !== "claude") throw new UiRequestError("only a Claude chat can do that");
  return target.controller;
}

/** One of a Claude tab's items by the key another device reads it by. */
function itemByKey(
  workspaceId: string,
  tabId: string,
  itemKey: string,
  agent: ChatAgent = "claude",
): ChatItem {
  const item = conversationOf(sourceOf(workspaceId, tabId, agent)).items.find(
    (each) => each.key === itemKey,
  );
  if (!item) throw new UiRequestError(`no item ${itemKey} in that tab`);
  return item;
}

/** One of the user's messages by its item's key, with the id rewinding to it takes. */
function userMessageByKey(
  workspaceId: string,
  tabId: string,
  itemKey: string,
): UserItem & { uuid: string } {
  const item = itemByKey(workspaceId, tabId, itemKey);
  if (item.kind !== "user") throw new UiRequestError(`no message ${itemKey} of the user's there`);
  if (!item.uuid) throw new UiRequestError("that message has no id yet: Claude has not taken it");
  return item as UserItem & { uuid: string };
}

/** The tab's conversation as another device reads it; throws when the tab is gone. */
function sourceOf(workspaceId: string, tabId: string, agent: ChatAgent): ChatSource {
  const source = tabSource(workspaceId, tabId, agent);
  if (!source) throw new UiRequestError("that tab is gone");
  return source;
}

/** How long a tab's program may take to start and list its models. */
const READY_TIMEOUT_MS = 30_000;

function modelPickerContextOf(
  target: AgentTabController,
  model: ChatModel,
): ModelPickerContext | undefined {
  if (target.agent !== "claude") return undefined;
  const { controller } = target;
  return {
    profileDefault: controller.claudeProfileDefaultModel,
    defaultLabel: i18next.t("settings:profiles.connection.default"),
    fallbackModels: model.init?.models.length
      ? undefined
      : borrowedClaudeModels(
          useClaudeModelCatalog.getState(),
          controller.modelCatalogKey,
          controller.key,
        ),
  };
}

/**
 * Waits for the tab's program to run and list its models, as its composer
 * waits to offer them, and for a Codex tab's thread to tell its model;
 * fails when the program is not running and is not starting.
 */
function whenReady(
  workspaceId: string,
  tabId: string,
  agent: AgentTabController["agent"],
  allowMissingInit = false,
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  const check = (): boolean | Error => {
    const chat = useChatStore.getState().tabs[key];
    if (!chat) return new UiRequestError("that tab is gone");
    const { phase, model } = chat;
    if (phase === "held") return new UiRequestError("its workspace's connection dropped");
    // Claude tells its model with its first turn; until then it runs the default.
    const told = agent === "claude" || model.model !== undefined;
    // An attached Claude process can already run with initialize gone from its log.
    const initialized = model.init || (allowMissingInit && agent === "claude" && phase === "ready");
    if (model.process === "running" && initialized && told) return true;
    if (phase === "failed" || phase === "not-found") {
      return new UiRequestError(`its program did not start${chat.error ? `: ${chat.error}` : ""}`);
    }
    if (model.process === "exited" || phase === "ended") {
      return new UiRequestError(
        "its program is not running; a message (chat send) starts it again",
      );
    }
    return false;
  };
  const now = check();
  if (now === true) return Promise.resolve();
  if (now instanceof Error) return Promise.reject(now);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new UiRequestError("its program took too long to start"));
    }, READY_TIMEOUT_MS);
    const stop = useChatStore.subscribe(() => {
      const next = check();
      if (next === false) return;
      clearTimeout(timer);
      stop();
      if (next === true) resolve();
      else reject(next);
    });
  });
}

/** How long a tab's conversation may take to show settings its program took. */
const SHOWN_TIMEOUT_MS = 5_000;

/**
 * Waits until the tab's conversation shows what `plan` set: a program
 * answers a request before its answer is read into the conversation.
 * Gives up quietly after a while; what it shows then is told.
 */
function whenShown(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  plan: ChatSettingsPlan,
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  const { agent, controller } = target;
  const profileDefault =
    plan.model === "default" && agent === "claude"
      ? controller.claudeProfileDefaultModel
      : undefined;
  const shown = (): boolean => {
    const chat = useChatStore.getState().tabs[key];
    if (!chat) return true;
    const now = chatChoicesOf(agent, chat.model, modelPickerContextOf(target, chat.model));
    return (
      (plan.model === undefined || now.model === plan.model || now.model === profileDefault) &&
      (plan.effort === undefined || now.effort === plan.effort) &&
      (plan.mode === undefined || now.mode === plan.mode)
    );
  };
  if (shown()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, SHOWN_TIMEOUT_MS);
    const stop = useChatStore.subscribe(() => {
      if (shown()) done();
    });
  });
}

/** Sets what `wanted` asks of a running tab; throws on what it cannot take. */
async function applySettings(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  wanted: CliChatSettings,
  {
    allowDangerousMode = false,
    expectedMode,
    confirmMode = false,
  }: { allowDangerousMode?: boolean; expectedMode?: string; confirmMode?: boolean } = {},
): Promise<void> {
  const { agent, controller } = target;
  await whenReady(workspaceId, tabId, agent, true);
  const currentTab = () => {
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    if (!chat) throw new UiRequestError("that tab is gone");
    if (
      wanted.mode !== undefined &&
      expectedMode !== undefined &&
      chatChoicesOf(agent, chat.model).mode !== expectedMode
    ) {
      throw new UiRequestError("the tab's permission mode changed; run the command again");
    }
    return chat;
  };
  const chat = currentTab();
  let plan: ChatSettingsPlan;
  try {
    plan = planChatSettings(
      agent,
      chat.model,
      wanted,
      controller.supports("apply_flag_settings"),
      allowDangerousMode,
      modelPickerContextOf(target, chat.model),
    );
  } catch (err) {
    throw new UiRequestError((err as Error).message);
  }
  // The model first: the effort is the new model's.
  if (plan.model !== undefined) await controller.setModel(plan.model);
  if (plan.effort !== undefined) await controller.setEffort(plan.effort);
  if (plan.mode !== undefined) {
    currentTab();
    const applied = await controller.setPermissionMode(plan.mode);
    // A reply can explicitly name the mode the program accepted. If it does
    // not, the renderer may still be waiting to read the change from the log.
    if (
      confirmMode &&
      typeof applied === "object" &&
      applied !== null &&
      "mode" in applied &&
      typeof applied.mode === "string" &&
      applied.mode !== "" &&
      applied.mode !== plan.mode
    ) {
      throw new UiRequestError(
        i18next.t("errors:chat.permissionModeMismatch", {
          requested: plan.mode,
          applied: applied.mode,
        }),
      );
    }
  }
  await whenShown(workspaceId, tabId, target, plan);
}

/** The agent's profile a --profile flag names, by name (any case) or id. */
function profileNamed(agent: ChatAgent, name: string): string {
  const profiles = profilesOf(useAgentProfilesStore.getState().config, agent);
  const selector = name.trim();
  const exact = profiles.find((p) => p.id === selector);
  if (exact) return exact.id;
  const wanted = selector.toLowerCase();
  const id = profiles.find((p) => p.id.toLowerCase() === wanted);
  if (id) return id.id;
  const [match, ...others] = profiles.filter((p) => cliProfileName(p).toLowerCase() === wanted);
  if (others.length > 0) {
    throw new UiRequestError(i18next.t("errors:chat.ambiguousProfile", { name }));
  }
  if (match) return match.id;
  const names = profiles.map(cliProfileName).join(", ");
  throw new UiRequestError(`${agent} has no profile "${name}"; it has ${names}`);
}

const hasSettings = (settings: CliChatSettings | undefined): settings is CliChatSettings =>
  settings !== undefined &&
  (settings.model !== undefined || settings.effort !== undefined || settings.mode !== undefined);

export const chatHandlers: { [K in ChatOp]: CliUiHandler<K> } = {
  "chat.usage": profileUsage,
  "chat.profiles": async ({ agent, workspaceId }) => {
    const config = useAgentProfilesStore.getState().config;
    const { workspaces } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspaceId !== undefined && !workspace) throw new UiRequestError("that workspace is gone");
    const agents: ChatAgent[] = agent ? [agent] : ["claude", "codex"];
    return {
      profiles: agents.flatMap((a) => {
        const defaultId = workspace && resolveWorkspaceProfile(a, workspace, workspaces).profile.id;
        return profilesOf(config, a).map((profile) => ({
          id: profile.id,
          name: cliProfileName(profile),
          agent: a,
          isDefault: isDefaultProfileId(profile.id),
          ...(workspace
            ? {
                workspaceDefault: defaultId === profile.id,
                path: profile.dir
                  ? portableProfileDir(tildePath(profile.dir))
                  : defaultFolderLabel(a),
              }
            : {}),
        }));
      }),
    };
  },

  "chat.open": async ({
    workspaceId,
    agent,
    cwd,
    prompt,
    placement,
    settings,
    profile,
    instructions,
    from,
    user,
    allowDangerousMode,
  }) => {
    const props = chatPropsWithProfile(workspaceId, agent, {
      cwd,
      ...(instructions === undefined ? {} : { instructions }),
      ...(profile !== undefined ? { profileId: profileNamed(agent, profile) } : {}),
    });
    const tab =
      agent === "claude"
        ? ({ type: "claude", props } as const)
        : ({ type: "codex", props } as const);
    const tabId = openTab(workspaceId, tab, placement);
    const text = prompt.trim();
    const setting = hasSettings(settings);
    if (!setting && text === "") return { tabId };
    const target = agentTabController(workspaceId, tabId);
    if (!target) throw new UiRequestError("the new tab is gone");
    try {
      if (setting) {
        // Set before the first message so its turn runs with the new settings.
        await target.controller.open();
        await applySettings(workspaceId, tabId, target, settings, {
          allowDangerousMode: user || allowDangerousMode,
          confirmMode: text !== "",
        });
        if (text !== "") await sendToAgentTab(workspaceId, tabId, target, text, from);
      } else {
        await sendFirstMessage(workspaceId, tabId, target, text, from);
      }
    } catch (err) {
      return { tabId, error: (err as Error).message };
    }
    return { tabId };
  },

  "chat.instructions": async ({ workspaceId, tabId, text }) => {
    if (text !== undefined) await saveSessionInstructions(workspaceId, tabId, text);
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type !== "claude" && tab?.type !== "codex") {
      throw new UiRequestError("that tab is not a Claude or Codex tab");
    }
    const session = tab.props.instructions ?? "";
    const target = agentInstructionTarget(workspaceId, tab.type, tab.props.profileId, session);
    const { config } = useAgentInstructionsStore.getState();
    return {
      instructions: mergeAgentInstructions(config, target),
      session,
      layers: persistentInstructionLayers(config, target),
    };
  },

  "chat.state": async ({ workspaceId, tabId, peek, submissionId, after, includeWaitingId }) => {
    const tracked =
      submissionId ?? (after === undefined ? undefined : submissionAt(workspaceId, tabId, after));
    if (tracked) {
      const target = agentTabController(workspaceId, tabId);
      if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
      const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
      return {
        ...withProfile(workspaceId, tabId, chatSubmissionInfo(target.agent, chat, tracked)),
        trackedSubmission: true,
      };
    }
    if (peek && !opened(workspaceId, tabId)) {
      const target = agentTabController(workspaceId, tabId);
      if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
      return withProfile(workspaceId, tabId, chatInfoOf(target.agent, undefined, false));
    }
    return infoOf(workspaceId, tabId, await openedTab(workspaceId, tabId), includeWaitingId);
  },

  "chat.read": async ({ workspaceId, tabId, messages, since, subagents }) => {
    const target = await openedTab(workspaceId, tabId, true);
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    return {
      ...infoOf(workspaceId, tabId, target),
      ...chatEntriesOf(chat, {
        messages,
        since,
        subagents,
        ...extrasOf(workspaceId, tabId, target.agent),
      }),
    };
  },

  "chat.page": async ({ workspaceId, tabId, before, limit }) => {
    const target = await readableTab(workspaceId, tabId);
    const read = () => chatPageOf(sourceOf(workspaceId, tabId, target.agent), { before, limit });
    if (target.agent !== "claude") return read();
    // A subagent that ended opens on the device from the page it read: with its messages.
    return pageWithSubagents(read, (ids) => readSubagents(target, ids));
  },

  "chat.watch": async ({ workspaceId, tabId, watchId, limit, appends }) => {
    const target = await readableTab(workspaceId, tabId);
    // The panel a watch carries shows them too, once they come: asked now,
    // and again whenever its program comes to take questions, as after the
    // app restarts it starts only with the next message.
    const askWhenItCan = eachTimeItCan(
      () => {
        const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
        return chat?.phase === "ready" && chat.model.process === "running";
      },
      () => askMcp(workspaceId, tabId, target),
    );
    askWhenItCan();
    const watched = startChatWatch(
      watchId,
      () => tabSource(workspaceId, tabId, target.agent),
      limit,
      (change) => void ipcCallResult("remote", "chatChanged", { watchId, change }),
      () => void ipcCallResult("remote", "chatWatchEnded", { watchId }),
      {
        appends: appends === true,
        onChange: askWhenItCan,
        usageKey: () => {
          const props = chatPropsOf(workspaceId, tabId);
          return props ? planUsageKeyFor(target.agent, workspaceId, props.profileId) : null;
        },
      },
    );
    void readSubagents(target, unreadSubagentsOf(watched));
    return watched;
  },

  "chat.unwatch": async ({ watchId }) => {
    stopChatWatch(watchId);
    return {};
  },

  "chat.original": async ({ workspaceId, tabId, path }) => {
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    if (!chat) throw new UiRequestError("that tab is gone");
    const before = originalOf(chat, path);
    return before === undefined ? { found: false, before: null } : { found: true, before };
  },

  "chat.tool": async ({ workspaceId, tabId, ref }) => {
    const { agent } = await openedTab(workspaceId, tabId);
    const tool = chatToolOf(
      useChatStore.getState().tabs[chatKey(workspaceId, tabId)],
      ref,
      extrasOf(workspaceId, tabId, agent),
    );
    if (!tool) throw new UiRequestError(`no tool call "${ref}" in that tab`);
    return tool;
  },

  "chat.send": async ({
    workspaceId,
    tabId,
    text,
    from,
    user,
    images,
    files = [],
    when,
    device,
    submission,
    wait,
  }) => {
    const target = await openedTab(workspaceId, tabId);
    if (!user && infoOf(workspaceId, tabId, target).state === "asking") {
      throw new UiRequestError(
        "it is waiting for the user to answer a request; that is for the user to answer",
      );
    }
    // As the composer sends a dropped file: written where the program reads
    // it, its path's mention after the text.
    const paths = await Promise.all(
      files.map((file) => target.controller.attach(file.name, file.data)),
    );
    const mentions = paths.map(fileMention).join(" ");
    const body = mentions === "" ? text : text.trim() ? `${text}\n\n${mentions}` : mentions;
    const trustedSubmission = user && !from ? submission : undefined;
    try {
      return await sendToAgentTab(
        workspaceId,
        tabId,
        target,
        body,
        from,
        images,
        when,
        device,
        trustedSubmission,
        wait,
      );
    } catch (error) {
      if (trustedSubmission && error instanceof CodexReplyError) return { rejected: error.message };
      throw error;
    }
  },

  "chat.unqueue": async ({ workspaceId, tabId, id }) => {
    const { controller } = await openedTab(workspaceId, tabId);
    const item = controller.removeQueued(id);
    if (!item) throw new UiRequestError(`no held message ${id}: it went`);
    return { text: item.text };
  },

  "chat.editHeld": async ({ workspaceId, tabId, id, text, device, from }) => {
    const { controller } = await openedTab(workspaceId, tabId);
    const item = controller.state.queue.find((q) => q.id === id);
    if (!item) throw new UiRequestError(`no held message ${id}: it went`);
    if (!text.trim() && item.images.length === 0) {
      throw new UiRequestError("a message needs text or an image");
    }
    if (!controller.editQueued(id, text, device, from))
      throw new UiRequestError(`no held message ${id}: it went`);
    return {};
  },

  "chat.dropHeld": async ({ agentsOnly }) => {
    let dropped = 0;
    for (const [workspaceId, tabs] of Object.entries(useTabsStore.getState().byWorkspace)) {
      for (const tab of Object.values(tabs ?? {})) {
        if (tab.type !== "claude" && tab.type !== "codex") continue;
        const queue = useChatStore.getState().tabs[chatKey(workspaceId, tab.id)]?.queue ?? [];
        const theirs = queue.filter((q) => q.from?.device || (!agentsOnly && q.device));
        if (theirs.length === 0) continue;
        const target = agentTabController(workspaceId, tab.id);
        for (const q of theirs) if (target?.controller.removeQueued(q.id)) dropped++;
      }
    }
    return { dropped };
  },

  "chat.withdraw": async ({ workspaceId, tabId, itemKey }) => {
    const controller = await claudeTab(workspaceId, tabId, true);
    const item = itemByKey(workspaceId, tabId, itemKey);
    if (item.kind !== "user") throw new UiRequestError(`no message ${itemKey} of the user's there`);
    if (!isWaiting(item) || !item.sentUuid) return { withdrawn: false };
    if (!controller.supports("cancel_async_message")) {
      throw new UiRequestError("its program cannot take a message back");
    }
    return { withdrawn: await controller.withdraw(item.sentUuid) };
  },

  "chat.hurry": async ({ workspaceId, tabId }) => {
    const controller = await claudeTab(workspaceId, tabId, true);
    const { model } = controller.state;
    // As the composer's ⌘↩ with nothing typed: only while messages sent in the turn wait.
    const waiting = model.items.some((item) => item.kind === "user" && item.state === "sent");
    if (model.running && waiting) await controller.readHeldNow();
    return {};
  },

  "chat.export": async ({ workspaceId, tabId }) => {
    const { agent } = await openedTab(workspaceId, tabId, true);
    const { items, tools } = conversationOf(sourceOf(workspaceId, tabId, agent));
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    const cwd = tab?.type === "claude" || tab?.type === "codex" ? tab.props.cwd : "";
    return {
      markdown: conversationMarkdown(items, tools, (tool) => toolSummary(tool, cwd), {
        user: i18next.t("chat.commands.export_user"),
        assistant: agent === "claude" ? "Claude" : "Codex",
      }),
    };
  },

  "chat.entryItem": async ({ workspaceId, tabId, i }) => {
    // Opened as chat.read opens it, so that the entries are counted alike.
    const { agent } = await openedTab(workspaceId, tabId, true);
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    const index = chatItemIndexOf(chat, i, extrasOf(workspaceId, tabId, agent));
    const item =
      index === null ? undefined : conversationOf(sourceOf(workspaceId, tabId, agent)).items[index];
    if (!item) throw new UiRequestError(`no message #${i} in that tab`);
    return {
      itemKey: item.key,
      kind: item.kind,
      ...(item.kind === "user" ? { text: item.text } : {}),
    };
  },

  "chat.restart": async ({ workspaceId, tabId }) => {
    const target = agentTabController(workspaceId, tabId);
    if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
    const { phase } = target.controller.state;
    // As its banner does: an ended program goes on with its session; a failed one opens again.
    // One that runs starts again on its session, as the card after /login offers.
    if (phase === "ended" || phase === "ready") await target.controller.restart();
    else if (phase === "failed" || phase === "not-found") await target.controller.open();
    else throw new UiRequestError("its program is starting");
    return {};
  },

  "chat.checkSignIn": async ({ workspaceId, tabId }) => {
    const target = agentTabController(workspaceId, tabId);
    if (target?.agent !== "codex") throw new UiRequestError("that tab is not a Codex tab");
    await target.controller.refreshAccount();
    // Its answer waits for the next frame to reach the model.
    target.controller.flushNow();
    return { signedOut: target.controller.model.signedOut === true };
  },

  "chat.outsideFiles": async ({ workspaceId }) => {
    const root = useWorkspacesStore
      .getState()
      .workspaces.find((w) => w.id === workspaceId)?.rootPath;
    const files = new Set<string>();
    for (const tab of Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {})) {
      if (tab.type !== "claude" && tab.type !== "codex") continue;
      const chat = useChatStore.getState().tabs[chatKey(workspaceId, tab.id)];
      if (!chat) continue;
      // The call that started a job, or a file named, may be in the history read before the
      // program ran.
      const { model, history } = chat;
      const items = history ? [...history.items, ...model.items] : model.items;
      const tools = history ? { ...history.tools, ...model.tools } : model.tools;
      for (const job of jobsOf(model)) {
        const path = jobOutputFile(job, tools);
        if (path) files.add(path);
      }
      // As the tab's own previews read them (outsideLinksOf), its HTML files' folders aside.
      if (root)
        for (const file of outsideLinksOf(items, tools, tab.props.cwd, root).files) {
          files.add(file);
        }
    }
    return { files: [...files] };
  },

  "chat.interrupt": async ({ workspaceId, tabId }) => {
    const target = await openedTab(workspaceId, tabId);
    const { state } = infoOf(workspaceId, tabId, target);
    if (state !== "working" && state !== "asking")
      throw new UiRequestError("it has no turn to stop");
    await target.controller.interrupt();
    return {};
  },

  "chat.mode": async ({ workspaceId, tabId }) => {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type !== "claude" && tab?.type !== "codex") return null;
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    const model = chat?.model;
    // A pending pick can already be shown in the composer. Require the program
    // and the composer to agree before using a mode for delegation.
    const mode =
      chat?.phase === "ready" &&
      model?.process === "running" &&
      model.permissionMode === model.confirmedPermissionMode
        ? model.confirmedPermissionMode
        : undefined;
    return { agent: tab.type, ...(mode === undefined ? {} : { mode }) };
  },

  "chat.settings": async ({
    workspaceId,
    tabId,
    settings,
    user,
    allowDangerousMode,
    expectedMode,
  }) => {
    const target = await openedTab(workspaceId, tabId);
    if (hasSettings(settings))
      await applySettings(workspaceId, tabId, target, settings, {
        allowDangerousMode: user || allowDangerousMode,
        expectedMode,
      });
    else await whenReady(workspaceId, tabId, target.agent, true);
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    if (!chat) throw new UiRequestError("that tab is gone");
    return chatChoicesOf(target.agent, chat.model, modelPickerContextOf(target, chat.model));
  },

  "chat.rename": async ({ workspaceId, tabId, title }) => {
    const target = await readableTab(workspaceId, tabId);
    useTabsStore.getState().renameTab(workspaceId, tabId, title.trim());
    // A tab's view names its session when the user renames it; one not shown
    // has no view to, so a running program is told here (none is started for it).
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    if (target.agent === "claude" && chat?.model.process === "running") {
      void target.controller.renameSession(title).catch(() => {});
    }
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (!tab) throw new UiRequestError("that tab is gone");
    return { title: tab.title };
  },

  "chat.toolCall": async ({ workspaceId, tabId, toolUseId, maxText }) => {
    const { agent } = await readableTab(workspaceId, tabId);
    const tool = conversationOf(sourceOf(workspaceId, tabId, agent)).tools[toolUseId];
    if (!tool) throw new UiRequestError(`no tool call ${toolUseId} in that tab`);
    return viewToolOf(tool, maxText);
  },

  "chat.pageEntries": async ({ page, subagents }) => ({
    entries: pageEntriesOf(page, subagents === true),
  }),

  "chat.panel": async ({ workspaceId, tabId }) => {
    const target = await readableTab(workspaceId, tabId);
    askMcp(workspaceId, tabId, target);
    return chatPanelOf(sourceOf(workspaceId, tabId, target.agent));
  },

  "chat.stopTask": async ({ workspaceId, tabId, taskId }) => {
    const target = await openedTab(workspaceId, tabId);
    if (target.agent !== "claude") throw new UiRequestError("a Codex chat has no tasks to stop");
    const task = useChatStore.getState().tabs[chatKey(workspaceId, tabId)]?.model.tasks[taskId];
    if (!task) throw new UiRequestError(`no task ${taskId} in that tab`);
    if (task.status !== "running") throw new UiRequestError(`the task ${taskId} is not running`);
    if (!target.controller.supports("stop_task")) {
      throw new UiRequestError(
        `its Claude Code cannot stop a task: ${firstVersionOf("stop_task")} or later can`,
      );
    }
    await target.controller.stopTask(taskId);
    return {};
  },

  "chat.rewindPreview": async ({ workspaceId, tabId, itemKey }) => {
    const target = await openedTab(workspaceId, tabId);
    if (target.agent === "codex") return target.controller.previewRewind(itemKey);
    return target.controller.previewRewind(userMessageByKey(workspaceId, tabId, itemKey).uuid);
  },

  "chat.rewind": async ({ workspaceId, tabId, itemKey, files }) => {
    const target = await openedTab(workspaceId, tabId);
    const controller = target.controller;
    if (controller.state.model.running) throw new UiRequestError("a turn is running");
    if (target.agent === "codex") {
      const item = itemByKey(workspaceId, tabId, itemKey, "codex");
      if (item.kind !== "user") throw new UiRequestError("Select a Codex user message");
      await target.controller.rewind(item, { files, draft: false });
      return {};
    }
    // The message goes back in the composer of the device that asked, not this one's.
    await controller.rewind(userMessageByKey(workspaceId, tabId, itemKey), {
      files,
      draft: false,
    });
    return {};
  },

  "chat.fork": async ({ workspaceId, tabId, itemKey }) => {
    const target = await readableTab(workspaceId, tabId);
    const props = chatPropsOf(workspaceId, tabId);
    if (!props) throw new UiRequestError("that tab is gone");
    if (target.agent === "codex") {
      const item = itemKey ? itemByKey(workspaceId, tabId, itemKey, "codex") : undefined;
      if (item && item.kind !== "user" && item.kind !== "assistant") {
        throw new UiRequestError("Select a Codex user message or final answer");
      }
      const fork = target.controller.forkPoint(item);
      const newTab = openTab(
        workspaceId,
        {
          type: "codex",
          props: chatPropsWithProfile(workspaceId, "codex", {
            cwd: props.cwd,
            fork,
            profileId: target.controller.profileId,
            chosen: target.controller.inheritedChoice(),
            ...target.controller.inheritedInstructions(),
          }),
        },
        { background: true },
      );
      try {
        const child = await openedTab(workspaceId, newTab);
        if (child.agent !== "codex") throw new UiRequestError("the forked tab is gone");
        await child.controller.prepareSend();
      } catch (error) {
        // A fork that did not start is no tab to keep: the device that asked is told.
        await closeTabWithConfirm(workspaceId, newTab).catch(() => {});
        throw error;
      }
      return { tabId: newTab, ...(item?.kind === "user" ? { draft: item.text } : {}) };
    }
    const controller = target.controller;
    // As the tab's own buttons fork: from one of the user's messages, what
    // came before it, the message in the new tab's composer; from an answer,
    // up to it; from the panel, all of it.
    let fork: ForkPoint | null;
    let draft: UserItem | undefined;
    if (itemKey) {
      const item = itemByKey(workspaceId, tabId, itemKey);
      if (item.kind !== "user" && item.kind !== "assistant") {
        throw new UiRequestError(`no message ${itemKey} there to fork from`);
      }
      if (!item.uuid) throw new UiRequestError("that message has no id yet");
      fork = controller.forkPoint(item.uuid, { before: item.kind === "user" });
      if (item.kind === "user") draft = item;
    } else {
      const point = controller.forkPoint("", { before: false });
      fork = point ? { sessionId: point.sessionId } : null;
    }
    if (!fork && !draft) throw new UiRequestError("it has no session to fork yet");
    const newTab = openTab(
      workspaceId,
      {
        type: "claude",
        props: chatPropsWithProfile(workspaceId, "claude", {
          cwd: props.cwd,
          ...(fork ? { fork } : {}),
          ...controller.inherited(),
        }),
      },
      // Behind what the window shows: whoever sits at this computer keeps their place.
      { background: true },
    );
    // The message goes in the composer of the device that asked, not this one's.
    return { tabId: newTab, ...(draft?.text ? { draft: draft.text } : {}) };
  },

  "chat.background": async ({ workspaceId, tabId, toolUseId }) => {
    const controller = await claudeTab(workspaceId, tabId, true);
    const tool = conversationOf(sourceOf(workspaceId, tabId, "claude")).tools[toolUseId];
    if (!tool) throw new UiRequestError(`no tool call ${toolUseId} in that tab`);
    if (!controller.state.model.running) throw new UiRequestError("it has no turn running");
    await controller.backgroundTool(toolUseId);
    return {};
  },

  "chat.mcp": async ({ workspaceId, tabId, server, action, redirectUri, callbackUrl }) => {
    const controller = await claudeTab(workspaceId, tabId, true);
    const { model, phase } = controller.state;
    if (phase !== "ready" || model.process !== "running") {
      throw new UiRequestError("its program is not running");
    }
    if (model.mcp && !model.mcp.some((s) => s.name === server)) {
      throw new UiRequestError(`it has no MCP server "${server}"`);
    }
    switch (action) {
      case "reconnect":
        await controller.mcpReconnect(server);
        return {};
      case "enable":
      case "disable":
        await controller.mcpToggle(server, action === "enable");
        return {};
      case "signIn":
        // The page comes back to the asking device's own loopback listener.
        if (!redirectUri || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirectUri)) {
          throw new UiRequestError("a sign-in needs a loopback address to come back to");
        }
        return controller.mcpSignInFor(server, redirectUri);
      case "signedIn":
        if (!callbackUrl) throw new UiRequestError("a sign-in needs the address it came back to");
        await controller.mcpSignedIn(server, callbackUrl);
        return {};
    }
  },

  "chat.config": async ({ workspaceId, tabId, set }) => {
    const target = agentTabController(workspaceId, tabId);
    if (target?.agent === "codex") {
      const codex = target.controller;
      if (!set) return { config: await codex.readDefaults(true) };
      try {
        await codex.saveDefaults(set, true);
      } catch (err) {
        if (err instanceof CodexConfigRefusal) throw new UiRequestError(err.message);
        throw err;
      }
      return {};
    }
    const controller = await claudeTab(workspaceId, tabId, true);
    // As the dialog reads them, the keys last listed or listed now.
    const read = async () => {
      const [config, listed] = await Promise.all([
        controller.readConfig(),
        controller.savedConfigKeys() ?? controller.listConfigKeys(),
      ]);
      const init = controller.state.model.init;
      return chatConfigOf({
        ...config,
        listed,
        models: init?.models ?? [],
        outputStyles: init?.outputStyles,
        effort: controller.supports("update_settings"),
      });
    };
    if (!set) return { config: await read() };
    // As the dialog's button waits for the turn to end.
    if (controller.state.model.running) {
      throw new UiRequestError("it is working: its settings change once its turn ends");
    }
    let plan: ReturnType<typeof configSetOf>;
    try {
      plan = configSetOf(set, await read());
    } catch (err) {
      if (err instanceof ConfigRefusal) throw new UiRequestError(err.message);
      throw err;
    }
    await controller.applyConfig(plan.messages, { model: plan.model, effort: plan.effort });
    return {};
  },

  "chat.remoteControl": async ({ workspaceId, tabId, enabled }) => {
    const controller = await claudeTab(workspaceId, tabId, true);
    const { model, phase } = controller.state;
    if (model.init && !model.init.remoteControl) {
      if (enabled === false) return { enabled: false };
      throw new UiRequestError("its account cannot turn on Remote Control");
    }
    if (!model.init || phase !== "ready" || model.process !== "running") {
      throw new UiRequestError("its program is not ready");
    }
    return controller.setRemoteControl(enabled);
  },

  "chat.history": async ({ workspaceId, agent, query, limit, peer }) => {
    const { workspaces, connectionStatusByWorkspaceId } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace?.rootPath) throw new UiRequestError("no such workspace");
    const cwd = workspace.rootPath;
    const config = useAgentProfilesStore.getState().config;
    const listed =
      agent === "claude"
        ? await claudeSessions(
            workspaceId,
            cwd,
            profilesOf(config, "claude").map((p) => p.id),
          )
        : peer
          ? await peerCodexThreads(
              workspace,
              config,
              connectionStatusByWorkspaceId[workspaceId],
              query,
            )
          : await codexThreads(
              workspaceId,
              cwd,
              profilesOf(config, "codex").map((p) => p.id),
            );
    const name = (profileId: string) => cliProfileName(profileOf(config, agent, profileId));
    const openIn = (sessionId: string) => tabWithSession(workspaceId, agent, sessionId);
    return { sessions: pastSessionsOf(listed, cwd, name, query, limit, openIn) };
  },

  "chat.resume": async ({ workspaceId, agent, sessionId, tabId, emptyOnly }) => {
    const open = tabWithSession(workspaceId, agent, sessionId);
    if (open) return { tabId: open };
    const cwd = workspaceRoot(workspaceId);
    const config = useAgentProfilesStore.getState().config;
    const listed =
      agent === "claude"
        ? await claudeSessions(
            workspaceId,
            cwd,
            profilesOf(config, "claude").map((p) => p.id),
          )
        : await codexThreads(
            workspaceId,
            cwd,
            profilesOf(config, "codex").map((p) => p.id),
          );
    const exact = listed.find((s) => s.sessionId === sessionId);
    const matches = exact ? [exact] : listed.filter((s) => s.sessionId.startsWith(sessionId));
    if (matches.length > 1) throw new UiRequestError("give more of the conversation id");
    const session = matches[0];
    if (!session)
      throw new UiRequestError(`no conversation ${sessionId} in that workspace's folder`);
    if (sessionId !== session.sessionId) {
      const alreadyOpen = tabWithSession(workspaceId, agent, session.sessionId);
      if (alreadyOpen) return { tabId: alreadyOpen };
      sessionId = session.sessionId;
    }
    if (tabId) {
      // In that tab, as its /resume and its empty conversation's list go on with one.
      const target = await openedTab(workspaceId, tabId);
      if (target.agent !== agent) throw new UiRequestError(`that tab is not a ${agent} tab`);
      if (target.agent === "claude") {
        await target.controller.resumeSession(sessionId, session.profileId, emptyOnly);
      } else {
        await target.controller.resumeThread(
          sessionId,
          session.title,
          session.profileId,
          emptyOnly,
        );
      }
      return { tabId };
    }
    // Its own profile's, the default too: not the one the workspace's rules would pick.
    const profileId = { profileId: session.profileId };
    const tab =
      agent === "claude"
        ? ({
            type: "claude",
            props: chatPropsWithProfile(workspaceId, "claude", { cwd, sessionId, ...profileId }),
          } as const)
        : ({
            type: "codex",
            props: chatPropsWithProfile(workspaceId, "codex", {
              cwd,
              threadId: sessionId,
              ...profileId,
            }),
          } as const);
    // Behind what the window shows: whoever sits at this computer keeps their place.
    return { tabId: openTab(workspaceId, tab, { background: true }) };
  },

  "chat.image": async ({ workspaceId, tabId, ref, maxChars, maxEdge, versioned, ifVersion }) => {
    // Read only: a Claude tab's transcript will do, its program not started for it.
    const { agent } = await readableTab(workspaceId, tabId);
    const image = imageOf(sourceOf(workspaceId, tabId, agent), ref);
    if (!image) throw new UiRequestError("no such image in that tab");
    return readChatImage(image, { maxChars, maxEdge, versioned, ifVersion });
  },

  "chat.commands": async ({ workspaceId, tabId }) => {
    const target = await openedTab(workspaceId, tabId);
    const key = chatKey(workspaceId, tabId);
    // Claude lists its own when its program starts; a program that will not
    // start leaves the app's.
    const model = useChatStore.getState().tabs[key]?.model;
    if (target.agent === "claude" && !model?.init && !model?.slashCommands) {
      await whenReady(workspaceId, tabId, target.agent).catch(() => {});
    }
    const chat = useChatStore.getState().tabs[key];
    if (!chat) throw new UiRequestError("that tab is gone");
    const collaboration =
      target.agent === "codex" && (await target.controller.availableCollaborationModes());
    return { commands: chatCommandsOf(target.agent, chat.model, collaboration) };
  },

  "chat.fileSuggestions": async ({ workspaceId, tabId, query }) => {
    // Asked as the user types: a tab whose program does not run has none,
    // and is not started for them.
    const target = agentTabController(workspaceId, tabId);
    if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
    if (!opened(workspaceId, tabId)) return { paths: [] };
    return { paths: await target.controller.fileSuggestions(query) };
  },

  "chat.command": async ({ workspaceId, tabId, name, args }) => {
    const target = await openedTab(workspaceId, tabId);
    return runRemoteCommand(workspaceId, tabId, target, name, args?.trim() ?? "");
  },

  "chat.profile": async ({ workspaceId, tabId, profile, fresh, dryRun, stop }) => {
    const target = await openedTab(workspaceId, tabId);
    const config = useAgentProfilesStore.getState().config;
    const profileId = profileNamed(target.agent, profile);
    const before = chatPropsOf(workspaceId, tabId)?.profileId;
    const from = cliProfileName(profileOf(config, target.agent, before));
    const to = cliProfileName(profileOf(config, target.agent, profileId));
    if (sameProfile(profileId, before)) {
      throw new UiRequestError(`it already runs with the profile "${to}"`);
    }
    const { state } = infoOf(workspaceId, tabId, target);
    // The user's from another device may stop the turn, as the chip's choice here does.
    if (!stop && (state === "working" || state === "asking")) {
      throw new UiRequestError(
        state === "working"
          ? "it is working; its turn would stop (wait for it: chat wait)"
          : "it is waiting for the user to answer a request",
      );
    }
    if (dryRun) return { from, to };
    if (fresh) await target.controller.switchProfile(profileId);
    else await target.controller.continueInProfile(profileId);
    return { from, to };
  },

  "chat.answer": async ({
    workspaceId,
    tabId,
    decision,
    message,
    expect,
    byAgent,
    updatedInput,
    stop,
    always,
    planMode,
  }) => {
    const target = await openedTab(workspaceId, tabId);
    // Main allowed an answer to that request, not to another; any of those
    // it waits on, as the card answers the one it shows (not always the first).
    const asked =
      useChatStore.getState().tabs[chatKey(workspaceId, tabId)]?.model.permissions ?? [];
    if (asked.length === 0) throw new UiRequestError("it no longer asks anything");
    const request = asked.find((r) => r.requestId === expect);
    if (!request) {
      throw new UiRequestError("its request changed or was answered; read it again");
    }
    if (
      byAgent &&
      (request.toolName === "AskUserQuestion" || request.toolName === "ExitPlanMode")
    ) {
      throw new UiRequestError("that request is for the user to answer in the app");
    }
    if (decision === "allow" && always && always.length > 0) {
      // By the index chat.read words them: the same wording, so the same list.
      const scopes = scopesOf(request.suggestions, (key, options) =>
        String(i18next.t(key, options)),
      );
      const suggestions = always.map((i) => {
        const scope = scopes[i];
        if (!scope) throw new UiRequestError(`the request has no suggestion ${i} to keep`);
        return scope.suggestion;
      });
      await target.controller.answerPermission(request, { kind: "allow-always", suggestions });
      return {};
    }
    if (planMode && request.toolName !== "ExitPlanMode") {
      throw new UiRequestError("only a plan's approval sets the mode it goes on in");
    }
    await target.controller.answerPermission(
      request,
      decision === "allow"
        ? {
            kind: "allow",
            ...(updatedInput ? { updatedInput } : {}),
            // As the plan card's approvals do.
            ...(planMode
              ? {
                  updatedPermissions: [{ type: "setMode", mode: planMode, destination: "session" }],
                }
              : {}),
          }
        : { kind: stop ? "deny-stop" : "deny", message: message ?? "" },
    );
    return {};
  },
};
