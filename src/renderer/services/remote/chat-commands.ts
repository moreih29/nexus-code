/**
 * A chat's slash commands as another device runs them (chat.commands,
 * chat.command): the agent's own, which go to it as a message; the
 * model and effort, which chat.configure sets; and those of the app's own
 * that change the conversation rather than open a view here, run as the
 * composer runs them. What one says (its card, its toast) is its answer;
 * a tab it opens, its tab id.
 */

import i18next from "i18next";
import type { ChatCommand } from "../../../../packages/remote-protocol/src";
import { toolSummary } from "../../components/chat/tool-row";
import { type ToastInput, watchToasts } from "../../components/ui/toast";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import type { AgentTabController } from "../chat/agent-tab";
import { APP_COMMANDS, appCommandsBeside, listedCommands } from "../chat/app-commands";
import { CODEX_COMMANDS } from "../chat/codex-commands";
import type { ChatModel, ToolCall } from "../chat/model";
import { withRelayed } from "../chat/relayed";
import { runAppCommand } from "../chat/run-app-command";
import { runCodexCommand } from "../chat/run-codex-command";
import { chatKey, useChatStore } from "../chat/store";
import { UiRequestError } from "../cli/handler";

/** The app's commands for a Claude tab that another device may run: those that change the chat. */
export const CLAUDE_REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "btw",
  "plan",
  "add-dir",
  "sandbox",
  "fork",
  "branch",
  "subtask",
  "background",
]);

/** Codex's commands the app runs that another device may run. */
export const CODEX_REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "new",
  "compact",
  "review",
  "init",
  "goal",
  "rename",
  "fork",
]);

/** The commands chat.configure sets instead. */
const SETTINGS: Readonly<Record<string, "model" | "effort">> = { model: "model", effort: "effort" };

const t = (key: string) => i18next.t(key);

/** A tab's commands for a "/" picker on another device. */
export function chatCommandsOf(agent: "claude" | "codex", model: ChatModel): ChatCommand[] {
  if (agent === "codex") {
    return CODEX_COMMANDS.filter((c) => CODEX_REMOTE_COMMANDS.has(c.name) || SETTINGS[c.name]).map(
      (c) => ({
        name: c.name,
        description: t(`chat.codex.commands.describe.${c.name}`),
        ...(SETTINGS[c.name]
          ? { runs: "settings" as const, sets: SETTINGS[c.name] }
          : { runs: "command" as const }),
        ...(c.argumentHint ? { args: c.argumentHint } : {}),
      }),
    );
  }
  const cli = listedCommands(model.init?.commands ?? []);
  const own: ChatCommand[] = cli.map((c) => ({
    name: c.name,
    description: c.description ?? "",
    ...(SETTINGS[c.name]
      ? { runs: "settings" as const, sets: SETTINGS[c.name] }
      : { runs: "send" as const }),
    ...(c.argumentHint ? { args: c.argumentHint } : {}),
  }));
  const app: ChatCommand[] = appCommandsBeside(cli, (name) => t(`chat.commands.describe.${name}`))
    .filter((c) => CLAUDE_REMOTE_COMMANDS.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      runs: "command" as const,
      ...(c.argumentHint ? { args: c.argumentHint } : {}),
    }));
  return [...own, ...app];
}

/** The app's command a name or alias calls, of those another device may run. */
function remoteCommandNamed(agent: "claude" | "codex", typed: string): string | null {
  const lower = typed.replace(/^\//, "").toLowerCase();
  const table = agent === "claude" ? APP_COMMANDS : CODEX_COMMANDS;
  const allowed = agent === "claude" ? CLAUDE_REMOTE_COMMANDS : CODEX_REMOTE_COMMANDS;
  const found = table.find((c) => [c.name, ...(c.aliases ?? [])].includes(lower));
  return found && allowed.has(found.name) ? found.name : null;
}

/**
 * Runs one of the app's commands for another device, as the composer runs
 * it typed; what it said, and the tab it opened, when it opened one.
 */
export async function runRemoteCommand(
  workspaceId: string,
  tabId: string,
  target: AgentTabController,
  typed: string,
  args: string,
): Promise<{ message?: string; tabId?: string }> {
  const name = remoteCommandNamed(target.agent, typed);
  if (!name) {
    throw new UiRequestError(
      `/${typed} is not one of the app's commands another device can run; chat.commands lists them`,
    );
  }
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "claude" && tab?.type !== "codex") throw new UiRequestError("that tab is gone");
  const props = tab.props;
  const rootPath =
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ??
    props.cwd;
  const key = chatKey(workspaceId, tabId);
  const chat = useChatStore.getState().tabs[key];
  if (!chat) throw new UiRequestError("that tab is gone");
  const { history, model } = chat;
  const items = withRelayed(
    history ? [...history.items, ...model.items] : model.items,
    props.relayed,
  );
  const tools = history ? { ...history.tools, ...model.tools } : model.tools;
  const before = new Set(Object.keys(useTabsStore.getState().byWorkspace[workspaceId] ?? {}));
  const cardBefore = chat.card?.id;
  const said: ToastInput[] = [];
  const stopWatching = watchToasts((toast) => said.push(toast));
  try {
    const shared = {
      workspaceId,
      tabId,
      cwd: props.cwd,
      rootPath,
      items,
      tools,
      summarize: (tool: ToolCall) => toolSummary(tool, props.cwd),
      // Nothing opens here for a command run from another device.
      openFileTab: () => {},
    };
    if (target.agent === "claude") {
      await runAppCommand(
        { name, args },
        { ...shared, controller: target.controller, openUrl: () => {} },
      );
    } else {
      await runCodexCommand(
        { name, args },
        {
          ...shared,
          controller: target.controller,
          ...(props.profileId ? { profileId: props.profileId } : {}),
        },
      );
    }
  } finally {
    stopWatching();
  }
  const problem = said.find((toast) => toast.kind !== "info");
  if (problem) throw new UiRequestError(problem.message);
  const card = useChatStore.getState().tabs[key]?.card;
  const fromCard = card && card.id !== cardBefore ? (card.error ?? card.text) : undefined;
  const message = fromCard ?? said.at(-1)?.message;
  const opened = Object.keys(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).find(
    (id) => !before.has(id),
  );
  return { ...(message ? { message } : {}), ...(opened ? { tabId: opened } : {}) };
}
