// Runs the Claude tab's own commands (app-commands.ts) where the tab is:
// a card above the composer, the clipboard, a file, the git view.

import i18next from "i18next";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { copyText } from "../../utils/clipboard";
import { closeTabWithConfirm } from "../editor/save/close-tab";
import { showChanges } from "../sessions/actions";
import {
  APP_COMMANDS,
  conversationMarkdown,
  copyIndex,
  exportFileName,
  exportRelPath,
  memoryFilesOf,
  nthAnswer,
} from "./app-commands";
import type { ChatController } from "./controller";
import type { ChatItem, ToolCall } from "./model";

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
}

export async function runAppCommand(
  command: { name: string; args: string },
  ctx: AppCommandContext,
): Promise<void> {
  const t = i18next.t.bind(i18next);
  const { controller } = ctx;
  const title = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
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
        const files = memoryFilesOf(await controller.contextUsage());
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
