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
  type AgentProfile,
  defaultProfileId,
  isDefaultProfileId,
  profileOf,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { CliChatInfo, CliChatSettings, CliUiOp } from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../ipc/client";
import { chatPropsWithProfile } from "../../state/operations/tabs";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  type AgentTabController,
  agentTabController,
  sendToAgentTab,
  sendUnseen,
  startAgentTab,
} from "../chat/agent-tab";
import { scopesOf } from "../chat/permission-scopes";
import { sameProfile } from "../chat/profile-moves";
import { turnHopsOf } from "../chat/relayed";
import { chatKey, useChatStore } from "../chat/store";
import { firstVersionOf } from "../chat/versions";
import { chatCommandsOf, runRemoteCommand } from "../remote/chat-commands";
import { fitImage, imageOf } from "../remote/chat-image";
import { type ChatSource, chatPageOf, conversationOf, viewToolOf } from "../remote/chat-page";
import { chatPanelOf } from "../remote/chat-panel";
import { startChatWatch, stopChatWatch, tabSource } from "../remote/chat-watch";
import { claudeSessions, codexThreads, pastSessionsOf, tabWithSession } from "../remote/history";
import { type ChatSettingsPlan, chatChoicesOf, planChatSettings } from "./chat-settings";
import { type ChatTabExtras, chatEntriesOf, chatInfoOf, chatToolOf } from "./chat-view";
import { type CliUiHandler, UiRequestError } from "./handler";
import { openTab } from "./placement";

type ChatOp = Extract<CliUiOp, `chat.${string}`>;

/** Whether the tab's conversation was opened since the app started. */
function opened(workspaceId: string, tabId: string): boolean {
  return useChatStore.getState().tabs[chatKey(workspaceId, tabId)] !== undefined;
}

async function openedTab(workspaceId: string, tabId: string): Promise<AgentTabController> {
  const target = agentTabController(workspaceId, tabId);
  if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
  if (!opened(workspaceId, tabId)) await target.controller.open();
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
  if (!opened(workspaceId, tabId)) {
    await (target.agent === "claude" ? target.controller.openToRead() : target.controller.open());
  }
  return target;
}

/** A profile as the CLI names it: its name, or "default" for the default one unnamed. */
function cliProfileName(profile: AgentProfile): string {
  return profile.name.trim() || (isDefaultProfileId(profile.id) ? "default" : profile.id);
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

function infoOf(workspaceId: string, tabId: string, { agent }: AgentTabController) {
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  return withProfile(workspaceId, tabId, chatInfoOf(agent, chat, sendUnseen(workspaceId, tabId)));
}

function withProfile(workspaceId: string, tabId: string, info: CliChatInfo): CliChatInfo {
  const profile = profileShown(workspaceId, tabId, info.agent);
  return profile ? { ...info, profile } : info;
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
  return {
    ...(props.relayed ? { relayed: props.relayed } : {}),
    ...(moves ? { moves } : {}),
  };
}

/** The tab's conversation as another device reads it; throws when the tab is gone. */
function sourceOf(workspaceId: string, tabId: string, agent: ChatAgent): ChatSource {
  const source = tabSource(workspaceId, tabId, agent);
  if (!source) throw new UiRequestError("that tab is gone");
  return source;
}

/** How long a tab's program may take to start and list its models. */
const READY_TIMEOUT_MS = 30_000;

/**
 * Waits for the tab's program to run and list its models, as its composer
 * waits to offer them, and for a Codex tab's thread to tell its model;
 * fails when the program is not running and is not starting.
 */
function whenReady(
  workspaceId: string,
  tabId: string,
  agent: AgentTabController["agent"],
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  const check = (): boolean | Error => {
    const chat = useChatStore.getState().tabs[key];
    if (!chat) return new UiRequestError("that tab is gone");
    const { phase, model } = chat;
    if (phase === "held") return new UiRequestError("its workspace's connection dropped");
    // Claude tells its model with its first turn; until then it runs the default.
    const told = agent === "claude" || model.model !== undefined;
    if (model.process === "running" && model.init && told) return true;
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
  agent: AgentTabController["agent"],
  plan: ChatSettingsPlan,
): Promise<void> {
  const key = chatKey(workspaceId, tabId);
  const shown = (): boolean => {
    const chat = useChatStore.getState().tabs[key];
    if (!chat) return true;
    const now = chatChoicesOf(agent, chat.model);
    return (
      (plan.model === undefined || now.model === plan.model) &&
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
  { agent, controller }: AgentTabController,
  wanted: CliChatSettings,
  user = false,
): Promise<void> {
  await whenReady(workspaceId, tabId, agent);
  const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
  if (!chat) throw new UiRequestError("that tab is gone");
  let plan: ChatSettingsPlan;
  try {
    plan = planChatSettings(
      agent,
      chat.model,
      wanted,
      controller.supports("apply_flag_settings"),
      user,
    );
  } catch (err) {
    throw new UiRequestError((err as Error).message);
  }
  // The model first: the effort is the new model's.
  if (plan.model !== undefined) await controller.setModel(plan.model);
  if (plan.effort !== undefined) await controller.setEffort(plan.effort);
  if (plan.mode !== undefined) await controller.setPermissionMode(plan.mode);
  await whenShown(workspaceId, tabId, agent, plan);
}

/** The agent's profile a --profile flag names, by name (any case) or id. */
function profileNamed(agent: ChatAgent, name: string): string {
  const profiles = profilesOf(useAgentProfilesStore.getState().config, agent);
  const wanted = name.trim().toLowerCase();
  const found = profiles.find(
    (p) =>
      p.id.toLowerCase() === wanted ||
      p.name.trim().toLowerCase() === wanted ||
      (isDefaultProfileId(p.id) && p.name.trim() === "" && wanted === "default"),
  );
  if (found) return found.id;
  const names = profiles.map((p) => p.name.trim() || "default").join(", ");
  throw new UiRequestError(`${agent} has no profile "${name}"; it has ${names}`);
}

const hasSettings = (settings: CliChatSettings | undefined): settings is CliChatSettings =>
  settings !== undefined &&
  (settings.model !== undefined || settings.effort !== undefined || settings.mode !== undefined);

export const chatHandlers: { [K in ChatOp]: CliUiHandler<K> } = {
  "chat.profiles": async ({ agent }) => {
    const config = useAgentProfilesStore.getState().config;
    const agents: ChatAgent[] = agent ? [agent] : ["claude", "codex"];
    return {
      profiles: agents.flatMap((a) =>
        profilesOf(config, a).map((p) => ({
          id: p.id,
          name: cliProfileName(p),
          agent: a,
          isDefault: isDefaultProfileId(p.id),
        })),
      ),
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
    from,
    user,
  }) => {
    const props = chatPropsWithProfile(workspaceId, agent, {
      cwd,
      ...(profile !== undefined ? { profileId: profileNamed(agent, profile) } : {}),
    });
    const tab =
      agent === "claude"
        ? ({ type: "claude", props } as const)
        : ({ type: "codex", props } as const);
    const tabId = openTab(workspaceId, tab, placement);
    if (!hasSettings(settings)) {
      startAgentTab(workspaceId, tabId, prompt, from);
      return { tabId };
    }
    // Set before the first message: its turn runs with them.
    const target = agentTabController(workspaceId, tabId);
    if (!target) throw new UiRequestError("the new tab is gone");
    try {
      await target.controller.open();
      await applySettings(workspaceId, tabId, target, settings, user);
      if (prompt.trim() !== "") {
        await sendToAgentTab(workspaceId, tabId, target, prompt.trim(), from);
      }
    } catch (err) {
      return { tabId, error: (err as Error).message };
    }
    return { tabId };
  },

  "chat.state": async ({ workspaceId, tabId, peek }) => {
    if (peek && !opened(workspaceId, tabId)) {
      const target = agentTabController(workspaceId, tabId);
      if (!target) throw new UiRequestError("that tab is not a Claude or Codex tab");
      return withProfile(workspaceId, tabId, chatInfoOf(target.agent, undefined, false));
    }
    return infoOf(workspaceId, tabId, await openedTab(workspaceId, tabId));
  },

  "chat.read": async ({ workspaceId, tabId, messages, since, subagents }) => {
    const target = await openedTab(workspaceId, tabId);
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
    return chatPageOf(sourceOf(workspaceId, tabId, target.agent), { before, limit });
  },

  "chat.watch": async ({ workspaceId, tabId, watchId, limit }) => {
    const target = await readableTab(workspaceId, tabId);
    return startChatWatch(
      watchId,
      () => tabSource(workspaceId, tabId, target.agent),
      limit,
      (change) => void ipcCallResult("remote", "chatChanged", { watchId, change }),
      () => void ipcCallResult("remote", "chatWatchEnded", { watchId }),
    );
  },

  "chat.unwatch": async ({ watchId }) => {
    stopChatWatch(watchId);
    return {};
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

  "chat.send": async ({ workspaceId, tabId, text, from, user, images }) => {
    const target = await openedTab(workspaceId, tabId);
    if (!user && infoOf(workspaceId, tabId, target).state === "asking") {
      throw new UiRequestError(
        "it is waiting for the user to answer a request; that is for the user to answer",
      );
    }
    await sendToAgentTab(workspaceId, tabId, target, text, from, images);
    return {};
  },

  "chat.interrupt": async ({ workspaceId, tabId }) => {
    const target = await openedTab(workspaceId, tabId);
    const { state } = infoOf(workspaceId, tabId, target);
    if (state !== "working" && state !== "asking")
      throw new UiRequestError("it has no turn to stop");
    await target.controller.interrupt();
    return {};
  },

  "chat.settings": async ({ workspaceId, tabId, settings, user }) => {
    const target = await openedTab(workspaceId, tabId);
    if (hasSettings(settings)) await applySettings(workspaceId, tabId, target, settings, user);
    else await whenReady(workspaceId, tabId, target.agent);
    const chat = useChatStore.getState().tabs[chatKey(workspaceId, tabId)];
    if (!chat) throw new UiRequestError("that tab is gone");
    return chatChoicesOf(target.agent, chat.model);
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

  "chat.turnHops": async ({ workspaceId, tabId }) => {
    const { agent } = await readableTab(workspaceId, tabId);
    return { hops: turnHopsOf(conversationOf(sourceOf(workspaceId, tabId, agent)).items) };
  },

  "chat.panel": async ({ workspaceId, tabId }) => {
    const { agent } = await readableTab(workspaceId, tabId);
    return chatPanelOf(sourceOf(workspaceId, tabId, agent));
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

  "chat.history": async ({ workspaceId, agent, query, limit }) => {
    const cwd = workspaceRoot(workspaceId);
    const config = useAgentProfilesStore.getState().config;
    const listed =
      agent === "claude"
        ? await claudeSessions(
            workspaceId,
            cwd,
            profilesOf(config, "claude").map((p) => p.id),
          )
        : await codexThreads(workspaceId, defaultProfileId("codex"));
    const name = (profileId: string) => cliProfileName(profileOf(config, agent, profileId));
    return { sessions: pastSessionsOf(listed, cwd, name, query, limit) };
  },

  "chat.resume": async ({ workspaceId, agent, sessionId }) => {
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
        : await codexThreads(workspaceId, defaultProfileId("codex"));
    const session = listed.find((s) => s.sessionId === sessionId);
    if (!session)
      throw new UiRequestError(`no conversation ${sessionId} in that workspace's folder`);
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

  "chat.image": async ({ workspaceId, tabId, ref, maxChars }) => {
    const { agent } = await openedTab(workspaceId, tabId);
    const image = imageOf(sourceOf(workspaceId, tabId, agent), ref);
    if (!image) throw new UiRequestError("no such image in that tab");
    return fitImage(image, maxChars);
  },

  "chat.commands": async ({ workspaceId, tabId }) => {
    const target = await openedTab(workspaceId, tabId);
    const key = chatKey(workspaceId, tabId);
    // Claude lists its own when its program starts; a program that will not
    // start leaves the app's.
    if (target.agent === "claude" && !useChatStore.getState().tabs[key]?.model.init) {
      await whenReady(workspaceId, tabId, target.agent).catch(() => {});
    }
    const chat = useChatStore.getState().tabs[key];
    if (!chat) throw new UiRequestError("that tab is gone");
    return { commands: chatCommandsOf(target.agent, chat.model) };
  },

  "chat.command": async ({ workspaceId, tabId, name, args }) => {
    const target = await openedTab(workspaceId, tabId);
    return runRemoteCommand(workspaceId, tabId, target, name, args?.trim() ?? "");
  },

  "chat.profile": async ({ workspaceId, tabId, profile, fresh, dryRun }) => {
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
    if (state === "working" || state === "asking") {
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
    updatedInput,
    stop,
    always,
  }) => {
    const target = await openedTab(workspaceId, tabId);
    // Main allowed an answer to the request the tab asked then: not to another.
    const request = useChatStore.getState().tabs[chatKey(workspaceId, tabId)]?.model.permissions[0];
    if (!request) throw new UiRequestError("it no longer asks anything");
    if (request.requestId !== expect) {
      throw new UiRequestError("its request changed or was answered; read it again");
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
    await target.controller.answerPermission(
      request,
      decision === "allow"
        ? { kind: "allow", ...(updatedInput ? { updatedInput } : {}) }
        : { kind: stop ? "deny-stop" : "deny", message: message ?? "" },
    );
    return {};
  },
};
