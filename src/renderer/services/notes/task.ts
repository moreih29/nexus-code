import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import i18next from "i18next";
import { noteLabel } from "../../../shared/notes/line-report";
import type { NoteLinkEntry } from "../../../shared/notes/links";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { chatPropsWithProfile } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { revealInWorkspace } from "../agent-sessions/actions";
import { startAgentTab } from "../chat/agent-tab";
import { titleOf } from "../chat/tab-title";
import { openTab } from "../cli/placement";
import { startTask } from "../workspace/tasks";
import { notesApi } from "./api";
import { tabLinkTarget } from "./conversation";
import { sendToConversation } from "./send-to-conversation";

interface TaskNote {
  workspaceId: string;
  tabId: string;
  noteId: string;
}

type Destination = { agent: ChatAgent; worktree: boolean } | { workspaceId: string; tabId: string };

export const NOTE_TASK_BATCH_LIMIT = 10;
export type NoteTaskBatchOutcome = "linked" | "link-failed" | "creation-failed";

function unassignedTask(node: ProseMirrorNode | null): boolean {
  return (
    node?.type.name === "taskItem" &&
    !node.attrs.nexusLink &&
    !node.attrs.checked &&
    Boolean(node.firstChild?.textContent.trim())
  );
}

export function checklistTasks(
  doc: ProseMirrorNode,
  pos: number,
  excluded?: ReadonlySet<number>,
): number[] {
  const list = doc.nodeAt(pos);
  const positions: number[] = [];
  if (list?.type.name === "taskList") {
    list.forEach((node, offset) => {
      const at = pos + 1 + offset;
      if (!excluded?.has(at) && unassignedTask(node)) positions.push(at);
    });
  }
  return positions;
}

export async function assignNoteTaskBatch(
  editor: Editor,
  positions: readonly number[],
  assign: (pos: number) => Promise<{ linked: boolean }>,
  outcome: (pos: number, result: NoteTaskBatchOutcome) => void,
) {
  const anchors = positions.slice(0, NOTE_TASK_BATCH_LIMIT).map((pos) => ({ at: pos + 1 }));
  const map = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
    for (const anchor of anchors) {
      if (anchor.at < 0) continue;
      const mapped = transaction.mapping.mapResult(anchor.at, 1);
      anchor.at = mapped.deletedAcross ? -1 : mapped.pos;
    }
  };
  editor.on("transaction", map);
  try {
    for (const anchor of anchors) {
      if (editor.isDestroyed) return;
      const pos = anchor.at - 1;
      if (pos < 0 || !unassignedTask(editor.state.doc.nodeAt(pos))) continue;
      let result: NoteTaskBatchOutcome;
      try {
        result = (await assign(pos)).linked ? "linked" : "link-failed";
      } catch {
        result = "creation-failed";
      }
      if (anchor.at > 0 && !editor.isDestroyed) outcome(anchor.at - 1, result);
    }
  } finally {
    editor.off("transaction", map);
  }
}

export function taskName(text: string): string {
  const name = text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
  return Array.from(name.slice(0, 80))
    .filter((char) => !/^[\uD800-\uDFFF]$/.test(char))
    .join("")
    .trimEnd();
}

export function noteTaskPrompt(
  text: string,
  title: string,
  heading: string,
  noteId: string,
  includeReport = true,
): string {
  const t = i18next.getFixedT(null, "notes");
  const interpolation = { escapeValue: false, skipOnVariables: true };
  const section = heading.trim()
    ? t("tasks.promptSection", { heading: noteLabel(heading), interpolation })
    : "";
  return [
    t("tasks.promptItem", { text: noteLabel(text, "", Infinity), interpolation }),
    t("tasks.promptNote", {
      title: noteLabel(title, "Untitled note"),
      section,
      id: noteId,
      interpolation,
    }),
    ...(includeReport ? [t("tasks.promptReport")] : []),
  ].join("\n");
}

function noteTaskParent(workspace: WorkspaceMeta): WorkspaceMeta {
  return (
    useWorkspacesStore.getState().workspaces.find(({ id }) => id === workspace.task?.parentId) ??
    workspace
  );
}

export function canMakeTask(
  workspace: WorkspaceMeta,
  repoKind: string | undefined,
  online: boolean,
): boolean {
  return (
    !workspace.task &&
    !(workspace.location.kind === "ssh" && !online) &&
    repoKind !== "non-repo" &&
    repoKind !== "git-missing"
  );
}

function trackTask(editor: Editor, pos: number) {
  let at: number | undefined = pos;
  const before = editor.state.doc.nodeAt(pos)?.attrs.nexusLink;
  function map({ transaction }: { transaction: Editor["state"]["tr"] }) {
    if (at === undefined) return;
    const mapped = transaction.mapping.mapResult(at, 1);
    at = mapped.deleted ? undefined : mapped.pos;
  }
  editor.on("transaction", map);
  return {
    set(linkId: string | null, expected = before) {
      if (at === undefined || editor.isDestroyed) return false;
      const node = editor.state.doc.nodeAt(at);
      if (node?.type.name !== "taskItem" || node.attrs.nexusLink !== expected) return false;
      const pos = at;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, nexusLink: linkId }),
      );
      at = pos;
      return true;
    },
    stop: () => editor.off("transaction", map),
  };
}

export async function assignNoteTask(
  editor: Editor,
  pos: number,
  note: TaskNote,
  title: () => string,
  flush: () => Promise<boolean>,
  destination: Destination,
  reveal = true,
): Promise<{ queued: boolean; linked: boolean }> {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== "taskItem" || !node.firstChild) throw new Error("missing to-do");
  const text = node.firstChild.textBetween(0, node.firstChild.content.size, " ", " ").trim();
  if (!text) throw new Error("empty to-do");
  let heading = "";
  editor.state.doc.forEach((block, offset) => {
    if (offset < pos && block.type.name === "heading") heading = block.textContent;
  });
  const anchor = trackTask(editor, pos);
  let linked: NoteLinkEntry | undefined;
  const attach = async (
    workspaceId: string,
    tabId: string,
    task?: NonNullable<NoteLinkEntry["link"]["task"]>,
  ) => {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type !== "claude" && tab?.type !== "codex") throw new Error("missing conversation");
    linked = await notesApi.addLink(note.workspaceId, note.noteId, {
      ...tabLinkTarget(workspaceId, tab),
      title: tab.title || titleOf(text),
      agent: tab.type,
      kind: task ? "task" : "line",
      ...(task ? { task } : {}),
    });
    if (!anchor.set(linked.id) || !(await flush()))
      throw new Error("could not save the to-do link");
    const current = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (current?.type === tab.type && current !== tab) {
      await notesApi.updateLinksForTab({
        ...tabLinkTarget(workspaceId, current),
        agent: current.type,
      });
    }
  };
  const rollback = async () => {
    if (!linked) return;
    const { id } = linked;
    linked = undefined;
    const removed = notesApi.removeLink(note.workspaceId, note.noteId, id);
    const restored = anchor.set(node.attrs.nexusLink, id) ? flush() : Promise.resolve(true);
    await Promise.allSettled([removed, restored]);
  };
  try {
    if (!(await flush())) throw new Error("could not save the note");
    const noteTitle = title();
    const prompt = noteTaskPrompt(text, noteTitle, heading, note.noteId);
    if ("tabId" in destination) {
      await attach(destination.workspaceId, destination.tabId);
      const queued = await sendToConversation(destination.workspaceId, destination.tabId, prompt);
      return { queued, linked: true };
    }

    const workspace = useWorkspacesStore
      .getState()
      .workspaces.find(({ id }) => id === note.workspaceId);
    if (!workspace) throw new Error("missing workspace");
    const { agent } = destination;
    const fallbackPrompt = noteTaskPrompt(text, noteTitle, heading, note.noteId, false);
    const parent = noteTaskParent(workspace);
    if (destination.worktree) {
      const started = await startTask(
        parent.id,
        taskName(text),
        prompt,
        { agent },
        undefined,
        undefined,
        undefined,
        {
          fallbackPrompt,
          async beforeAgentStart(task, tabId) {
            try {
              if (!task.task) throw new Error("missing task worktree");
              await attach(task.id, tabId, { workspaceId: task.id, branch: task.task.branch });
            } catch (error) {
              await rollback();
              throw error;
            }
          },
        },
      );
      if ("task" in started) {
        if (reveal && started.tabId)
          revealInWorkspace({ workspaceId: started.task.id, tabId: started.tabId });
        return { queued: false, linked: !started.preparationFailed };
      }
      if (started.kind !== "not-a-repo" && started.kind !== "not-connected")
        throw new Error(started.message);
    }

    const workspaceId = workspace.id;
    const props = chatPropsWithProfile<{ cwd: string; profileId?: string }>(workspaceId, agent, {
      cwd: workspace.rootPath,
    });
    const tabId = openTab(
      workspaceId,
      { type: agent, props },
      { background: true, besideTabId: note.tabId },
    );
    try {
      await attach(workspaceId, tabId);
    } catch {
      await rollback();
      startAgentTab(workspaceId, tabId, fallbackPrompt);
      return { queued: false, linked: false };
    }
    startAgentTab(workspaceId, tabId, prompt);
    return { queued: false, linked: true };
  } catch (error) {
    await rollback();
    throw error;
  } finally {
    anchor.stop();
  }
}

export async function taskRepoKind(workspaceId: string) {
  const result = await ipcCallResult("git", "getRepoInfo", { workspaceId });
  return result.ok ? result.value.kind : undefined;
}
