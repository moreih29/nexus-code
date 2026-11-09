// Runs the Claude tab's own commands (app-commands.ts) where the tab is:
// a card above the composer, the clipboard, a file, the git view.

import i18next from "i18next";
import { showConfirmDialog } from "../../components/ui/confirm-dialog";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { openClaudeTab } from "../../state/operations/tabs";
import { copyText } from "../../utils/clipboard";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { showChanges } from "../sessions/actions";
import { openTerminal } from "../terminal/open-terminal";
import { queueStartupInput } from "../terminal/pty-client";
import { agentCommandLine } from "../workspace/tasks";
import {
  APP_COMMANDS,
  backgroundSessionsOf,
  COMMAND_LINKS,
  conversationMarkdown,
  copyIndex,
  directoryArg,
  exportFileName,
  exportRelPath,
  hooksMarkdown,
  memoryFilesOf,
  nthAnswer,
  type PluginAction,
  permissionFiles,
  permissionsMarkdown,
  permissionsOf,
  pluginResultOf,
  pluginsOf,
  RESTART_AFTER,
  sandboxOn,
  skillsOf,
  subtaskPrompt,
  terminalCommandOf,
} from "./app-commands";
import type { ChatController } from "./controller";
import type { ChatItem, ToolCall } from "./model";
import { type CardSection, chatKey, useChatStore } from "./store";

export interface AppCommandContext {
  controller: ChatController;
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  /** The whole conversation: what was loaded from the session, then this run's. */
  items: readonly ChatItem[];
  tools: Readonly<Record<string, ToolCall>>;
  /** A tool call's one line, as the conversation shows it. */
  summarize: (tool: ToolCall) => string;
  openFileTab: (path: string) => void;
  openUrl: (url: string) => void;
}

export async function runAppCommand(
  command: { name: string; args: string },
  ctx: AppCommandContext,
): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const title = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
  const link = COMMAND_LINKS[command.name];
  if (link) {
    ctx.openUrl(link);
    return;
  }
  const terminal = terminalCommandOf(command.name, command.args);
  if (terminal) {
    const line = `${terminal.command}${terminal.argument ? ` ${terminal.argument}` : ""}`;
    runInTerminal(ctx, terminal.command, terminal.argument);
    controller.showCard({
      title,
      text: t("chat.commands.in_terminal", { command: line }),
      sections: RESTART_AFTER.has(command.name)
        ? [
            {
              title: t("chat.commands.restart_after"),
              empty: "",
              rows: [
                {
                  id: "restart",
                  label: t("chat.commands.restart_hint"),
                  actions: [
                    {
                      label: t("chat.commands.restart"),
                      run: () => {
                        controller.closeCard();
                        void controller.restart().catch(failed);
                      },
                    },
                  ],
                },
              ],
            },
          ]
        : undefined,
    });
    return;
  }
  switch (command.name) {
    case "btw": {
      if (!command.args) {
        showToast({ kind: "warning", message: t("chat.commands.btw_empty") });
        return;
      }
      const id = controller.showCard({ title, loading: true });
      try {
        const answer = await controller.askAside(command.args);
        controller.updateCard(id, { loading: false, text: answer ?? t("chat.commands.btw_none") });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "copy": {
      const n = copyIndex(command.args);
      const text = n === null ? null : nthAnswer(ctx.items, n);
      if (text === null) {
        showToast({ kind: "warning", message: t("chat.commands.copy_none") });
        return;
      }
      copyText(text);
      showToast({ kind: "info", message: t("chat.commands.copied") });
      return;
    }
    case "export": {
      const relPath = exportRelPath(
        command.args || exportFileName(ctx.items, new Date()),
        ctx.cwd,
        ctx.rootPath,
      );
      if (!relPath) {
        showToast({ kind: "error", message: t("chat.commands.export_bad_name") });
        return;
      }
      const content = conversationMarkdown(ctx.items, ctx.tools, ctx.summarize, {
        user: t("chat.commands.export_user"),
        assistant: "Claude",
      });
      const result = unwrapIpcResult(
        await ipcCallResult("fs", "writeFile", {
          workspaceId: ctx.workspaceId,
          relPath,
          content,
          expected: { exists: false },
        }),
      );
      if (result.kind === "conflict") {
        showToast({ kind: "error", message: t("chat.commands.export_exists", { name: relPath }) });
        return;
      }
      ctx.openFileTab(`${ctx.rootPath.replace(/\/+$/, "")}/${relPath}`);
      showToast({ kind: "info", message: t("chat.commands.exported", { name: relPath }) });
      return;
    }
    case "diff":
      showChanges(ctx.workspaceId);
      return;
    case "memory": {
      const id = controller.showCard({ title, loading: true });
      try {
        const files = memoryFilesOf(await controller.ask("get_context_usage"));
        controller.updateCard(id, {
          loading: false,
          files: files.map((file) => ({
            path: file.path,
            label: file.type ? `${file.type} · ${file.path}` : file.path,
          })),
          text: files.length === 0 ? t("chat.commands.memory_none") : undefined,
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "permissions": {
      const id = controller.showCard({ title, loading: true });
      try {
        const state = permissionsOf(await controller.ask("list_permission_rules"));
        controller.updateCard(id, {
          loading: false,
          text: permissionsMarkdown(state, t, controller.addedDirectories()),
          files: permissionFiles(state).map((path) => ({ path, label: path })),
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "add-dir": {
      const path = directoryArg(command.args, ctx.cwd);
      if (!path) {
        showToast({ kind: "warning", message: t("chat.commands.add_dir_empty") });
        return;
      }
      const dirs = controller.addedDirectories();
      if (!dirs.includes(path)) {
        await controller.applyFlags({ permissions: { additionalDirectories: [...dirs, path] } });
      }
      showToast({ kind: "info", message: t("chat.commands.added_dir", { path }) });
      return;
    }
    case "hooks": {
      const id = controller.showCard({ title, loading: true });
      try {
        controller.updateCard(id, {
          loading: false,
          text: hooksMarkdown(await controller.ask("get_hooks_listing"), t),
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "sandbox": {
      const arg = command.args.toLowerCase();
      if (arg === "on" || arg === "off") {
        await controller.applyFlags({ sandbox: { enabled: arg === "on" } });
        showToast({ kind: "info", message: t(`chat.commands.sandbox_${arg}`) });
        return;
      }
      if (arg) {
        showToast({ kind: "warning", message: t("chat.commands.sandbox_usage") });
        return;
      }
      const id = controller.showCard({ title, loading: true });
      try {
        const on = sandboxOn(await controller.ask("get_settings"));
        controller.updateCard(id, {
          loading: false,
          text: t(on ? "chat.commands.sandbox_is_on" : "chat.commands.sandbox_is_off"),
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "fork": {
      // The whole conversation so far, in a tab of its own.
      const sessionId = controller.currentSession();
      if (!sessionId) {
        showToast({ kind: "warning", message: t("chat.commands.fork_none") });
        return;
      }
      const tab = openClaudeTab(ctx.workspaceId, {
        cwd: ctx.cwd,
        fork: { sessionId },
        profileId: ctx.controller.profileId,
      });
      if (command.args) {
        const draft = { text: command.args, images: [], nonce: Date.now() };
        useChatStore
          .getState()
          .update(chatKey(ctx.workspaceId, tab.id), (prev) => ({ ...prev, draft }));
      }
      return;
    }
    case "subtask":
      if (!command.args) {
        showToast({ kind: "warning", message: t("chat.commands.subtask_empty") });
        return;
      }
      await controller.send(subtaskPrompt(command.args));
      return;
    case "tasks":
    case "workflows":
      await showTasks(ctx, title, command.name === "workflows");
      return;
    case "background": {
      if (controller.state.model.running) {
        showToast({ kind: "warning", message: t("chat.commands.background_busy") });
        return;
      }
      if (!controller.currentSession() && !command.args) {
        showToast({ kind: "warning", message: t("chat.commands.background_empty") });
        return;
      }
      const id = controller.showCard({ title, loading: true });
      try {
        const sent = await controller.sendToBackground(command.args);
        showToast({ kind: "info", message: t("chat.commands.background_sent", { id: sent }) });
        await closeTabWithConfirm(ctx.workspaceId, ctx.tabId);
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "skills": {
      const id = controller.showCard({ title, loading: true });
      try {
        const skills = skillsOf(await controller.ask("get_context_usage"));
        controller.updateCard(id, {
          loading: false,
          sections: [
            {
              title: t("chat.commands.skills_title", { count: skills.length }),
              empty: t("chat.commands.skills_none"),
              rows: skills.map((skill) => ({
                id: `${skill.source}/${skill.name}`,
                label: skill.name,
                detail: skill.source,
                actions: skill.path
                  ? [
                      {
                        label: t("chat.commands.open"),
                        run: () => ctx.openFileTab(skill.path ?? ""),
                      },
                    ]
                  : [],
              })),
            },
          ],
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
    case "plugin": {
      const [verb, ...rest] = command.args.split(/\s+/).filter(Boolean);
      if (!verb) {
        await showPlugins(ctx, title);
        return;
      }
      if (verb.toLowerCase() !== "install" || rest.length !== 1) {
        showToast({ kind: "warning", message: t("chat.commands.plugin_usage") });
        return;
      }
      await changePlugin(ctx, "install", rest[0]);
      await showPlugins(ctx, "/plugin");
      return;
    }
    case "help": {
      const lines = APP_COMMANDS.map(
        (c) =>
          `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${t(`chat.commands.describe.${c.name}`)}`,
      );
      controller.showCard({
        title,
        text: `${t("chat.commands.help_intro")}\n\n${lines.join("\n")}`,
      });
      return;
    }
    case "exit":
      await closeTabWithConfirm(ctx.workspaceId, ctx.tabId);
      return;
  }
}

/**
 * /tasks: what the session runs now, and the folder's background sessions
 * (`claude --bg`), to open in a terminal or stop. /workflows: the
 * session's workflows. Each action shows the card again as it then is.
 */
async function showTasks(
  ctx: AppCommandContext,
  title: string,
  workflows: boolean,
  cardId?: string,
): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const id = cardId ?? controller.showCard({ title, loading: true });
  const again = () => void showTasks(ctx, title, workflows, id);
  const failed = (err: Error) => showToast({ kind: "error", message: err.message });
  const status = (word: string) => t(`chat.commands.status.${word}`, { defaultValue: word });

  const tasks = Object.values(controller.state.model.tasks).filter((task) =>
    workflows ? task.type === "local_workflow" : task.status === "running",
  );
  const own: CardSection = {
    title: t(workflows ? "chat.commands.workflows_title" : "chat.commands.tasks_title"),
    empty: t(workflows ? "chat.commands.workflows_none" : "chat.commands.tasks_none"),
    rows: tasks.map((task) => ({
      id: task.taskId,
      label: task.description || task.taskId,
      detail: status(task.status),
      actions:
        task.status === "running"
          ? [
              {
                label: t("chat.commands.stop"),
                run: () => void controller.stopTask(task.taskId).then(again, failed),
              },
            ]
          : [],
    })),
  };
  if (workflows) {
    controller.updateCard(id, { loading: false, sections: [own] });
    return;
  }

  const sections = [own];
  let error: string | undefined;
  try {
    const run = unwrapIpcResult(
      await ipcCallResult("chat", "cli", {
        workspaceId: ctx.workspaceId,
        cwd: ctx.cwd,
        profileId: ctx.controller.profileId,
        command: { kind: "agents" },
      }),
    );
    if (run.code !== 0) throw new Error(run.stderr.trim() || `claude agents: ${run.code}`);
    sections.push({
      title: t("chat.commands.background_title"),
      empty: t("chat.commands.background_none"),
      rows: backgroundSessionsOf(run.stdout).map((session) => ({
        id: session.id,
        label: session.name === session.id ? session.id : `${session.name} · ${session.id}`,
        detail: status(session.status),
        actions: [
          {
            label: t("chat.commands.open"),
            run: () => {
              const { tabId } = openTerminal({ workspaceId: ctx.workspaceId, cwd: ctx.cwd });
              queueStartupInput(ctx.workspaceId, tabId, () => `claude attach ${session.id}\r`);
            },
          },
          ...(session.status === "stopped"
            ? []
            : [
                {
                  label: t("chat.commands.stop"),
                  run: () =>
                    void ipcCallResult("chat", "cli", {
                      workspaceId: ctx.workspaceId,
                      cwd: ctx.cwd,
                      profileId: ctx.controller.profileId,
                      command: { kind: "stop", id: session.id },
                    }).then(again, failed),
                },
              ]),
        ],
      })),
    });
  } catch (err) {
    error = (err as Error).message;
  }
  controller.updateCard(id, { loading: false, sections, error });
}

function failed(err: Error): void {
  showToast({ kind: "error", message: err.message });
}

/** Opens a terminal in the tab's folder that runs `command`, with `argument` quoted for its shell. */
function runInTerminal(ctx: AppCommandContext, command: string, argument: string): void {
  const { tabId } = openTerminal({ workspaceId: ctx.workspaceId, cwd: ctx.cwd });
  queueStartupInput(
    ctx.workspaceId,
    tabId,
    (shellPath) => agentCommandLine(command, argument, shellPath) ?? "",
  );
}

/**
 * /plugin: the installed plugins, to turn off or on, update or remove,
 * and Claude Code's own /plugin in a terminal for the marketplaces.
 */
async function showPlugins(ctx: AppCommandContext, title: string, cardId?: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const id = cardId ?? controller.showCard({ title, loading: true });
  const again = () => void showPlugins(ctx, title, id);
  const browse: CardSection = {
    title: t("chat.commands.marketplace_title"),
    empty: "",
    rows: [
      {
        id: "browse",
        label: t("chat.commands.marketplace_hint"),
        actions: [
          {
            label: t("chat.commands.marketplace_open"),
            run: () => runInTerminal(ctx, "claude", "/plugin"),
          },
        ],
      },
    ],
  };
  try {
    const run = unwrapIpcResult(
      await ipcCallResult("chat", "cli", {
        workspaceId: ctx.workspaceId,
        cwd: ctx.cwd,
        profileId: ctx.controller.profileId,
        command: { kind: "plugins" },
      }),
    );
    if (run.code !== 0) throw new Error(run.stderr.trim() || `claude plugin list: ${run.code}`);
    const change = (action: PluginAction, plugin: string, scope: string) => () =>
      void changePlugin(ctx, action, plugin, scope).then(again);
    const installed: CardSection = {
      title: t("chat.commands.plugins_title"),
      empty: t("chat.commands.plugins_none"),
      rows: pluginsOf(run.stdout).map((plugin) => {
        const scoped =
          plugin.scope === "user" || plugin.scope === "project" || plugin.scope === "local";
        return {
          id: `${plugin.scope}/${plugin.id}`,
          label: plugin.id,
          detail: [
            plugin.version,
            plugin.scope,
            t(plugin.enabled ? "chat.commands.plugin_on" : "chat.commands.plugin_off"),
          ]
            .filter(Boolean)
            .join(" · "),
          // A managed plugin is the organization's to change.
          actions: scoped
            ? [
                plugin.enabled
                  ? {
                      label: t("chat.commands.plugin_disable"),
                      run: change("disable", plugin.id, plugin.scope),
                    }
                  : {
                      label: t("chat.commands.plugin_enable"),
                      run: change("enable", plugin.id, plugin.scope),
                    },
                {
                  label: t("chat.commands.plugin_update"),
                  run: change("update", plugin.id, plugin.scope),
                },
                {
                  label: t("chat.commands.plugin_uninstall"),
                  run: () =>
                    void showConfirmDialog({
                      title: t("chat.commands.plugin_uninstall_title", { name: plugin.id }),
                      description: t("chat.commands.plugin_uninstall_body"),
                      confirmLabel: t("chat.commands.plugin_uninstall"),
                      variant: "destructive",
                    }).then((yes) =>
                      yes ? change("uninstall", plugin.id, plugin.scope)() : undefined,
                    ),
                },
              ]
            : [],
        };
      }),
    };
    controller.updateCard(id, { loading: false, sections: [installed, browse] });
  } catch (err) {
    controller.updateCard(id, {
      loading: false,
      sections: [browse],
      error: (err as Error).message,
    });
  }
}

/** Runs `claude plugin <action>`, says how it went, and has the session load the plugins again. */
async function changePlugin(
  ctx: AppCommandContext,
  action: PluginAction,
  plugin: string,
  scope?: string,
): Promise<void> {
  try {
    const run = unwrapIpcResult(
      await ipcCallResult("chat", "cli", {
        workspaceId: ctx.workspaceId,
        cwd: ctx.cwd,
        profileId: ctx.controller.profileId,
        command: {
          kind: "plugin",
          action,
          plugin,
          ...(scope === "user" || scope === "project" || scope === "local" ? { scope } : {}),
        },
      }),
    );
    const result = pluginResultOf(run);
    showToast({ kind: result.ok ? "info" : "error", message: result.message });
    if (result.ok) await ctx.controller.reloadPlugins();
  } catch (err) {
    failed(err as Error);
  }
}
