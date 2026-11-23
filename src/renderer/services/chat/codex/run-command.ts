import i18next from "i18next";
import { showConfirmDialog } from "../../../components/ui/confirm-dialog";
import { showToast } from "../../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { openCodexTab } from "../../../state/operations/tabs";
import { useTabsStore } from "../../../state/stores/tabs";
import { copyText } from "../../../utils/clipboard";
import { showChanges } from "../../agent-sessions/actions";
import { planChatSettings } from "../../cli/chat-settings";
import { closeTabWithConfirm } from "../../editor/save/close-tab";
import {
  conversationMarkdown,
  copyIndex,
  exportFileName,
  exportRelPath,
  nthAnswer,
} from "../app-commands";
import { type ChatItem, currentModelInfo, type ToolCall } from "../model";
import {
  CODEX_INIT_PROMPT,
  codexCommandsListed,
  codexSkillsOf,
  codexStatusMarkdown,
  goalCommandOf,
  goalOf,
  reviewTargetOf,
} from "./commands";
import type { CodexController } from "./controller";

export interface CodexCommandContext {
  controller: CodexController;
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  profileId?: string;
  items: readonly ChatItem[];
  tools: Readonly<Record<string, ToolCall>>;
  summarize: (tool: ToolCall) => string;
  openFileTab: (path: string) => void;
}

const IDLE_ONLY = new Set(["new", "compact", "review", "init"]);

export async function runCodexCommand(
  command: { name: string; args: string },
  ctx: CodexCommandContext,
): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const title = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
  if (command.name === "compact" || command.name === "review") await controller.prepareSend();
  const threadId = controller.currentThread();
  if (IDLE_ONLY.has(command.name) && controller.model.running) {
    showToast({ kind: "warning", message: t("chat.codex.commands.busy") });
    return;
  }
  switch (command.name) {
    case "fast":
      await runFast(controller, command.args);
      return;
    case "plan":
    case "default":
      if (command.args) throw new Error(t("chat.codex.commands.collaboration.usage"));
      await controller.setCollaborationMode(command.name);
      showToast({ kind: "info", message: t(`chat.codex.commands.collaboration.${command.name}`) });
      return;
    case "model":
    case "effort": {
      const plan = planChatSettings(
        "codex",
        controller.model,
        { [command.name]: command.args },
        true,
      );
      if (plan.model) await controller.setModel(plan.model);
      if (plan.effort) await controller.setEffort(plan.effort);
      return;
    }
    case "new":
      await controller.newThread();
      return;
    case "fork": {
      if (!threadId || controller.model.items.length === 0) {
        showToast({ kind: "warning", message: t("chat.commands.fork_none") });
        return;
      }
      const shown = useTabsStore.getState().byWorkspace[ctx.workspaceId]?.[ctx.tabId]?.title;
      const chosen = controller.inheritedChoice();
      openCodexTab(ctx.workspaceId, {
        cwd: ctx.cwd,
        ...controller.inheritedInstructions(),
        fork: { ...controller.forkPoint(), ...(shown ? { title: shown } : {}) },
        profileId: controller.profileId,
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
      if (!threadId) throw new Error("Codex has no thread to compact");
      await controller.ask("thread/compact/start", { threadId });
      return;
    case "review":
      if (!threadId) throw new Error("Codex has no thread to review");
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
      if (command.args === "refresh") await controller.listMcpServers();
      else await showMcp(ctx, title);
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
      const listed = codexCommandsListed(
        (name) => t(`chat.codex.commands.describe.${name}`),
        await controller.availableCollaborationModes(),
      );
      const lines = listed.map(
        (c) => `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description}`,
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

async function runFast(controller: CodexController, args: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const action = args.trim().toLowerCase();
  if (!["", "status", "on", "off"].includes(action)) {
    throw new Error(t("chat.codex.commands.fast_usage"));
  }
  await controller.prepareSend();
  if (!controller.model.init) {
    await controller.ask("model/list");
    controller.flushNow();
  }
  const model = controller.model;
  const tier = currentModelInfo(model.init?.models ?? [], model.model)?.fastTier;
  const threadId = controller.currentThread();
  if (!threadId) throw new Error("Codex has no thread");
  if (!tier && action !== "off") throw new Error(t("chat.codex.commands.fast_unavailable"));
  const active =
    tier && (model.serviceTier == null ? tier.isDefault : model.serviceTier === tier.id);
  const enabled = action === "status" ? active : action === "on" || (!action && !active);
  if (action !== "status") {
    try {
      await controller.setServiceTier(threadId, enabled && tier ? tier.id : "default");
    } catch (err) {
      if (err instanceof Error && err.message.includes("experimentalApi")) {
        throw new Error(t("chat.codex.commands.fast_restart"));
      }
      throw err;
    }
  }
  const message = t(enabled ? "chat.codex.commands.fast_on" : "chat.codex.commands.fast_off");
  showToast({
    kind: "info",
    message: enabled && tier?.description ? `${message} · ${tier.description}` : message,
  });
}

async function runGoal(ctx: CodexCommandContext, title: string, args: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const threadId = controller.currentThread();
  if (!threadId) {
    showToast({ kind: "warning", message: t("chat.codex.commands.goal_no_thread") });
    return;
  }
  const goal = goalCommandOf(args);
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

async function showMcp(ctx: CodexCommandContext, title: string): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const id = controller.showCard({ title, loading: true });
  try {
    const servers = await controller.listMcpServers();
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
