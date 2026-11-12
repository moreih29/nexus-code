// Runs the Codex tab's own commands (codex-commands.ts) where the tab is:
// a request to its app-server, a card above the composer, the clipboard,
// a file, the git view, another tab.

import i18next from "i18next";
import { showConfirmDialog } from "../../components/ui/confirm-dialog";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { openCodexTab } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { copyText } from "../../utils/clipboard";
import { showChanges } from "../agent-sessions/actions";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import {
  conversationMarkdown,
  copyIndex,
  exportFileName,
  exportRelPath,
  nthAnswer,
} from "./app-commands";
import {
  CODEX_COMMANDS,
  CODEX_INIT_PROMPT,
  codexSkillsOf,
  codexStatusMarkdown,
  goalCommandOf,
  goalOf,
  mcpServersOf,
  reviewTargetOf,
} from "./codex-commands";
import type { CodexController } from "./codex-controller";
import type { ChatItem, ToolCall } from "./model";

export interface CodexCommandContext {
  controller: CodexController;
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  profileId?: string;
  /** The whole conversation: what was loaded before, then this run's. */
  items: readonly ChatItem[];
  tools: Readonly<Record<string, ToolCall>>;
  /** A tool call's one line, as the conversation shows it. */
  summarize: (tool: ToolCall) => string;
  openFileTab: (path: string) => void;
}

/** The ones that start a turn, or start the thread again: not while a turn runs. */
const IDLE_ONLY = new Set(["new", "compact", "review", "init"]);

export async function runCodexCommand(
  command: { name: string; args: string },
  ctx: CodexCommandContext,
): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const title = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
  const threadId = controller.currentThread();
  if (IDLE_ONLY.has(command.name) && controller.model.running) {
    showToast({ kind: "warning", message: t("chat.codex.commands.busy") });
    return;
  }
  switch (command.name) {
    case "new":
      await controller.newThread();
      return;
    case "fork": {
      // The thread so far, in a tab of its own; this one stays as it is.
      if (!threadId || controller.model.items.length === 0) {
        showToast({ kind: "warning", message: t("chat.commands.fork_none") });
        return;
      }
      const shown = useTabsStore.getState().byWorkspace[ctx.workspaceId]?.[ctx.tabId]?.title;
      // The fork runs with the model and effort the tab shows.
      const chosen = controller.inheritedChoice();
      openCodexTab(ctx.workspaceId, {
        cwd: ctx.cwd,
        fork: { threadId, ...(shown ? { title: shown } : {}) },
        ...(ctx.profileId ? { profileId: ctx.profileId } : {}),
        ...(chosen ? { chosen } : {}),
      });
      return;
    }
    case "rename": {
      const name = command.args.trim();
      if (!name) {
        showToast({ kind: "warning", message: t("chat.codex.commands.rename_empty") });
        return;
      }
      if (!threadId) {
        showToast({ kind: "warning", message: t("chat.commands.fork_none") });
        return;
      }
      await controller.ask("thread/name/set", { threadId, name });
      return;
    }
    case "compact":
      if (!threadId) return;
      await controller.ask("thread/compact/start", { threadId });
      return;
    case "review":
      if (!threadId) return;
      await controller.ask("review/start", {
        threadId,
        target: reviewTargetOf(command.args),
        delivery: "inline",
      });
      return;
    case "init":
      await controller.send(CODEX_INIT_PROMPT);
      return;
    case "goal":
      await runGoal(ctx, title, command.args);
      return;
    case "status":
      controller.showCard({ title, text: codexStatusMarkdown(controller.model, ctx.cwd, t) });
      return;
    case "diff":
      showChanges(ctx.workspaceId);
      return;
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
    case "export":
      await exportConversation(ctx, command.args);
      return;
    case "mcp":
      await showMcp(ctx, title);
      return;
    case "skills":
      await showSkills(ctx, title);
      return;
    case "logout": {
      const yes = await showConfirmDialog({
        title: t("chat.codex.commands.logout_title"),
        description: t("chat.codex.commands.logout_body"),
        confirmLabel: t("chat.codex.commands.logout"),
        variant: "destructive",
      });
      if (!yes) return;
      await controller.ask("account/logout");
      await controller.refreshAccount();
      return;
    }
    case "help": {
      const lines = CODEX_COMMANDS.map(
        (c) =>
          `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${t(`chat.codex.commands.describe.${c.name}`)}`,
      );
      controller.showCard({
        title,
        text: `${t("chat.codex.commands.help_intro")}\n\n${lines.join("\n")}`,
      });
      return;
    }
    case "exit":
      await closeTabWithConfirm(ctx.workspaceId, ctx.tabId);
      return;
  }
}

/** /goal: the thread's goal shown, set, paused or resumed, or cleared. */
async function runGoal(ctx: CodexCommandContext, title: string, args: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const threadId = controller.currentThread();
  if (!threadId) {
    showToast({ kind: "warning", message: t("chat.codex.commands.goal_no_thread") });
    return;
  }
  const goal = goalCommandOf(args);
  // A goal shown before is out of date once it changes.
  if (goal.kind !== "show" && controller.state.card?.title.startsWith("/goal")) {
    controller.closeCard();
  }
  switch (goal.kind) {
    case "clear":
      await controller.ask("thread/goal/clear", { threadId });
      showToast({ kind: "info", message: t("chat.codex.commands.goal_cleared") });
      return;
    case "status":
      await controller.ask("thread/goal/set", { threadId, status: goal.status, origin: "user" });
      showToast({
        kind: "info",
        message: t(
          goal.status === "paused"
            ? "chat.codex.commands.goal_paused"
            : "chat.codex.commands.goal_resumed",
        ),
      });
      return;
    case "set":
      await controller.ask("thread/goal/set", {
        threadId,
        objective: goal.objective,
        status: "active",
        origin: "user",
      });
      showToast({ kind: "info", message: t("chat.codex.commands.goal_set") });
      return;
    case "show": {
      const id = controller.showCard({ title, loading: true });
      try {
        const current = goalOf(await controller.ask("thread/goal/get", { threadId }));
        controller.updateCard(id, {
          loading: false,
          text: current
            ? [
                current.objective,
                `${t(`chat.codex.commands.goal_status.${current.status}`, { defaultValue: current.status })}${
                  current.tokensUsed !== undefined
                    ? ` · ${t("chat.codex.commands.goal_tokens", {
                        used: current.tokensUsed.toLocaleString(),
                      })}`
                    : ""
                }`,
              ].join("\n\n")
            : t("chat.codex.commands.goal_none"),
        });
      } catch (err) {
        controller.updateCard(id, { loading: false, error: (err as Error).message });
      }
      return;
    }
  }
}

/** /export: the conversation as Markdown, in a file under the tab's folder. */
async function exportConversation(ctx: CodexCommandContext, name: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const relPath = exportRelPath(
    name || exportFileName(ctx.items, new Date()),
    ctx.cwd,
    ctx.rootPath,
  );
  if (!relPath) {
    showToast({ kind: "error", message: t("chat.commands.export_bad_name") });
    return;
  }
  const content = conversationMarkdown(ctx.items, ctx.tools, ctx.summarize, {
    user: t("chat.commands.export_user"),
    assistant: "Codex",
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
}

/** /mcp: the MCP servers Codex has, how each stands, and how many tools it gives. */
async function showMcp(ctx: CodexCommandContext, title: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const id = controller.showCard({ title, loading: true });
  try {
    const threadId = controller.currentThread();
    const servers = mcpServersOf(
      await controller.ask("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        ...(threadId ? { threadId } : {}),
      }),
    );
    controller.updateCard(id, {
      loading: false,
      sections: [
        {
          title: t("chat.codex.commands.mcp_title", { count: servers.length }),
          empty: t("chat.codex.commands.mcp_none"),
          rows: servers.map((server) => ({
            id: server.name,
            label: server.name,
            detail: [
              server.status
                ? t(`chat.codex.commands.mcp_status.${server.status}`, {
                    defaultValue: server.status,
                  })
                : undefined,
              t("chat.codex.commands.mcp_tools", { count: server.tools }),
            ]
              .filter(Boolean)
              .join(" · "),
            actions: [],
          })),
        },
      ],
    });
  } catch (err) {
    controller.updateCard(id, { loading: false, error: (err as Error).message });
  }
}

/** /skills: the skills Codex finds for the folder, each to open. */
async function showSkills(ctx: CodexCommandContext, title: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const id = controller.showCard({ title, loading: true });
  try {
    const skills = codexSkillsOf(await controller.ask("skills/list", { cwds: [ctx.cwd] }));
    controller.updateCard(id, {
      loading: false,
      sections: [
        {
          title: t("chat.commands.skills_title", { count: skills.length }),
          empty: t("chat.commands.skills_none"),
          rows: skills.map((skill) => ({
            id: skill.path ?? skill.name,
            label: skill.name,
            detail: [skill.scope, skill.enabled ? undefined : t("chat.commands.plugin_off")]
              .filter(Boolean)
              .join(" · "),
            actions: skill.path
              ? [{ label: t("chat.commands.open"), run: () => ctx.openFileTab(skill.path ?? "") }]
              : [],
          })),
        },
      ],
    });
  } catch (err) {
    controller.updateCard(id, { loading: false, error: (err as Error).message });
  }
}
