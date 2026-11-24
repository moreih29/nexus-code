import { ScrollText } from "lucide-react";
import { Tabs } from "radix-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { noteTime } from "../../services/notes/note-time";
import {
  type PeerNoteTab,
  type PeerWorkspaceTarget,
  peerTabId,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { TranscriptPanel } from "../notes/transcript-panel";
import { EmptyState } from "../ui/empty-state";
import { MarkdownBody } from "../ui/markdown-body";
import { PeerReadOnlyBadge } from "./labels";
import { type PeerNote, peerTranscript, readPeerNote } from "./notes-model";
import { peerSearchErrorKey } from "./search-model";

export function withoutHeading(markdown: string): string {
  return markdown.replace(/^# [^\n]*\n*/, "");
}

export function PeerNoteMarkdown({ source }: { source: string }) {
  return (
    <div className="note-read" data-testid="peer-note-body">
      <MarkdownBody source={source} links="web-only" />
    </div>
  );
}

export function PeerNoteView({
  note,
  workspaceId,
  workspaceName,
}: {
  note: PeerNote;
  workspaceId: string;
  workspaceName: string;
}) {
  const { t } = useTranslation("notes");
  const reading = useMemo(() => peerTranscript(note), [note]);
  const recordings = reading.recordings.length;
  const [transcriptOpen, setTranscriptOpen] = useState<boolean | null>(null);
  const showTranscript = transcriptOpen ?? recordings > 0;
  const hideTranscript = useCallback(() => setTranscriptOpen(false), []);
  const title = note.title || t("panel.untitled");

  return (
    <div
      className="@container/note flex h-full min-h-0 flex-col bg-[var(--surface-island-bg,transparent)]"
      data-testid="peer-note-view"
    >
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-border px-6 pt-3 pb-2.5">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <h2
            className={cn(
              "truncate text-[17px] font-semibold",
              note.title ? "text-foreground" : "text-muted-foreground",
            )}
            title={title}
          >
            {title}
          </h2>
          <span className="truncate text-app-micro text-muted-foreground">
            {workspaceName} · {noteTime(note.updatedAt)}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!showTranscript && recordings > 0 && (
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) border border-border px-2.5 text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)]"
              onClick={() => setTranscriptOpen(true)}
              data-testid="note-show-transcript"
            >
              <ScrollText className="size-3.5" aria-hidden="true" />
              {t("transcript.show")}
            </button>
          )}
          <PeerReadOnlyBadge />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @min-[720px]/note:flex-row">
        <div className="note-doc relative min-h-0 min-w-0 flex-1 overflow-y-auto px-7 pt-4">
          <PeerNoteMarkdown source={note.title ? withoutHeading(note.markdown) : note.markdown} />
        </div>
        {showTranscript && (
          <TranscriptPanel
            workspaceId={workspaceId}
            noteId={note.id}
            reading={reading}
            onClose={hideTranscript}
          />
        )}
      </div>
    </div>
  );
}

export function PeerNoteTabBody({
  target,
  tab,
  selected,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  tab: PeerNoteTab;
  selected: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId } = target;
  const show = canRead && selected;
  const [result, setResult] = useState<IpcResult<PeerNote> | null>(null);
  const [note, setNote] = useState<PeerNote | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on reconnect
  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    const { signal } = controller;
    void readPeerNote({ deviceId, workspaceId }, tab.noteId, signal).then(
      (next) => {
        if (signal.aborted) return;
        setResult(next);
        if (next.ok) setNote(next.value);
        else if (next.kind === "not-found") setNote(null);
      },
      () => {},
    );
    return () => controller.abort();
  }, [show, rejoin, deviceId, workspaceId, tab.noteId]);

  const error = updateNeeded
    ? t("peerWorkspace.updateNeeded")
    : note || !result || result.ok
      ? null
      : result.kind === "not-found"
        ? t("notes:editor.missing")
        : t(peerSearchErrorKey(result.kind));

  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(peerTabId(tab))}
      className={cn("min-h-0 flex-1 flex-col", selected ? "flex" : "hidden")}
      data-testid="peer-note-tab"
    >
      {error || !note ? (
        <EmptyState
          title={error ?? t(show ? "notes:editor.loading" : "peerWorkspace.connectionUnavailable")}
          tone="status"
          className="flex-1"
        />
      ) : (
        <PeerNoteView note={note} workspaceId={workspaceId} workspaceName={target.workspace.name} />
      )}
    </Tabs.Content>
  );
}
