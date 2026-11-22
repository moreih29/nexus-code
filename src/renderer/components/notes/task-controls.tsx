import type { Editor } from "@tiptap/core";
import { Bot, ChevronDown, MessageCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { clockOf } from "../../../shared/notes/transcript";
import {
  type ChatAgent,
  chatAgentOf,
  DEFAULT_TASK_AGENT,
} from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { assignNoteTask, canMakeTask, taskRepoKind } from "../../services/notes/task";
import { useGitStore } from "../../state/stores/git";
import { useTerminalStore } from "../../state/stores/terminal";
import { selectWorkspaceConnectionStatus, useWorkspacesStore } from "../../state/stores/workspaces";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { ConversationChip, type NotePlace, useNoteConversations } from "./conversation-chips";
import { type TaskWidget, taskWidgets } from "./editor/task-widgets";
import { ConversationDestinations, useDestinations } from "./send-to-agent";
import type { TranscriptJump } from "./transcript-rows";

const NO_WIDGETS: TaskWidget[] = [];

export function NoteTaskControls({
  editor,
  note,
  title,
  flush,
  onTranscript,
}: {
  editor: Editor;
  note: NotePlace;
  title: () => string;
  flush: () => Promise<boolean>;
  onTranscript: (jump: TranscriptJump) => void;
}) {
  const { t } = useTranslation("notes");
  const [widgets, setWidgets] = useState(NO_WIDGETS);
  useLayoutEffect(() => {
    const sync = () => {
      if (editor.isDestroyed) return;
      const next = taskWidgets(editor.view);
      setWidgets((before) =>
        before.length === next.length && before.every((widget, i) => widget === next[i])
          ? before
          : next,
      );
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === note.workspaceId);
  const parent = workspaces.find((w) => w.id === workspace?.task?.parentId) ?? workspace;
  const rows = useNoteConversations();
  const chips = new Map(rows.map((row) => [row.entry.id, row]));
  const repo = useGitStore((s) => parent && s.sessions.get(parent.id)?.repoInfo.kind);
  const connection = useWorkspacesStore(
    (s) => parent && selectWorkspaceConnectionStatus(s, parent.id),
  );
  const online = connection === "connected" || connection === "unstable";
  const preferred = useTerminalStore((s) => chatAgentOf(s.taskAgent ?? DEFAULT_TASK_AGENT));
  const [picker, setPicker] = useState<TaskWidget>();
  const [busy, setBusy] = useState(false);
  const assigning = useRef(false);
  const run = async (widget: TaskWidget, destination: Parameters<typeof assignNoteTask>[5]) => {
    const pos = widget.taskPos();
    if (pos === undefined || assigning.current || editor.isDestroyed) return;
    if (!editor.state.doc.nodeAt(pos)?.firstChild?.textContent.trim()) return;
    assigning.current = true;
    setBusy(true);
    try {
      const queued = await assignNoteTask(editor, pos, note, title, flush, destination);
      if (queued) showToast({ kind: "info", message: t("agent.sentQueued") });
    } catch {
      showToast({ kind: "error", message: t("tasks.assignError") });
    } finally {
      assigning.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {widgets.map((widget) => {
        const chip = widget.linkId ? chips.get(widget.linkId) : undefined;
        const at = widget.at;
        const label = [widget.speaker, at === undefined ? "" : clockOf(at)]
          .filter(Boolean)
          .join(" ");
        return createPortal(
          <>
            {label &&
              (at === undefined ? (
                <span className="note-task-chip text-muted-foreground">{label}</span>
              ) : (
                <button
                  type="button"
                  className="note-task-chip text-muted-foreground"
                  title={t("tasks.showTranscript")}
                  onClick={() =>
                    onTranscript({ speaker: widget.speaker, at, origin: widget.origin })
                  }
                >
                  {label}
                </button>
              ))}
            {chip ? (
              <ConversationChip {...chip} line />
            ) : (
              parent && (
                <TaskMenu
                  parent={parent}
                  repo={repo}
                  online={online}
                  preferred={preferred}
                  disabled={busy}
                  onNew={(agent, worktree) => void run(widget, { agent, worktree })}
                  onExisting={() => setPicker(widget)}
                />
              )
            )}
          </>,
          widget.dom,
          widget.dom.dataset.noteTaskWidget,
        );
      })}
      {picker && (
        <TaskConversationPicker
          note={note}
          onClose={() => setPicker(undefined)}
          onSend={(destination) => {
            setPicker(undefined);
            void run(picker, destination);
          }}
        />
      )}
    </>
  );
}

function TaskMenu({
  parent,
  repo,
  online,
  preferred,
  disabled,
  onNew,
  onExisting,
}: {
  parent: WorkspaceMeta;
  repo?: string;
  online: boolean;
  preferred: ChatAgent;
  disabled: boolean;
  onNew: (agent: ChatAgent, worktree: boolean) => void;
  onExisting: () => void;
}) {
  const { t } = useTranslation("notes");
  const [open, setOpen] = useState(false);
  const [detected, setDetected] = useState<string>();
  const worktree = canMakeTask(parent, repo && repo !== "detecting" ? repo : detected, online);
  const probe = worktree && (!repo || repo === "detecting") && detected === undefined;
  useEffect(() => {
    if (!open || !probe) return;
    let active = true;
    void taskRepoKind(parent.id)
      .catch(() => undefined)
      .then((kind) => {
        if (active) setDetected(kind ?? "detecting");
      });
    return () => {
      active = false;
    };
  }, [open, parent.id, probe]);
  const agents: ChatAgent[] = preferred === "claude" ? ["claude", "codex"] : ["codex", "claude"];

  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <button
          type="button"
          className="note-task-chip note-task-action text-muted-foreground"
          disabled={disabled}
        >
          <Bot className="size-3" aria-hidden="true" />
          {t("tasks.action")}
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {agents.map((agent) => {
          const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
          return (
            <DropdownMenuItem key={agent} disabled={probe} onSelect={() => onNew(agent, worktree)}>
              <span className="flex items-center gap-2">
                <Icon className="size-3.5" aria-hidden="true" />
                {t(worktree ? "tasks.newTask" : "tasks.newConversation", {
                  agent: t(`common:task.agents.${agent}`),
                })}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuItem onSelect={onExisting}>
          <span className="flex items-center gap-2">
            <MessageCircle className="size-3.5" aria-hidden="true" />
            {t("tasks.existing")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function TaskConversationPicker({
  note,
  onClose,
  onSend,
}: {
  note: NotePlace;
  onClose: () => void;
  onSend: (destination: { workspaceId: string; tabId: string }) => void;
}) {
  const { t } = useTranslation("notes");
  const destinations = useDestinations(note.workspaceId, note.noteId, true);
  const [selected, setSelected] = useState<string>();
  const choice = destinations.find(({ session }) => session.key === selected);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      aria-describedby={undefined}
    >
      <DialogHeader title={t("agent.existing")} close />
      <div className="mt-3 flex flex-col gap-3">
        <ConversationDestinations
          destinations={destinations}
          selected={selected}
          onSelect={setSelected}
        />
        <Button
          className="self-end"
          size="sm"
          disabled={!choice}
          onClick={() => {
            if (choice) onSend(choice.session);
          }}
        >
          {t("agent.send")}
        </Button>
      </div>
    </Dialog>
  );
}
