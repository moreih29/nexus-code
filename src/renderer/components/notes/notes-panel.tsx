import i18next from "i18next";
import { NotebookPen, Plus, Search, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { NoteSummary } from "../../../shared/notes/types";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { notesApi } from "../../services/notes/api";
import { noteTime } from "../../services/notes/note-time";
import { useRecorderStore } from "../../services/notes/recorder";
import { openOrRevealNoteTab } from "../../state/operations";
import { useLayoutStore } from "../../state/stores/layout";
import { findLeaf } from "../../state/stores/layout/helpers";
import { useTabsStore } from "../../state/stores/tabs";
import { Button } from "../ui/button";
import { showToast } from "../ui/toast";

export function NotesPanel({ workspace }: { workspace: WorkspaceMeta }) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState(false);
  const activeNoteId = useActiveNoteId(workspace.id);

  const load = useCallback(async () => {
    try {
      setNotes(await notesApi.list(workspace.id));
      setError(false);
    } catch {
      setError(true);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = notesApi.onChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const create = async () => {
    try {
      const note = await notesApi.create(workspace.id);
      openOrRevealNoteTab(workspace.id, note.id);
    } catch (e) {
      showToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <NotesPanelView
      notes={notes}
      error={error}
      activeNoteId={activeNoteId}
      workspaceId={workspace.id}
      onOpen={(note) => openOrRevealNoteTab(workspace.id, note.id, note.title)}
      onCreate={() => void create()}
    />
  );
}

export type NoteRowFacts = Pick<NoteSummary, "id" | "title" | "updatedAt"> &
  Partial<Pick<NoteSummary, "excerpt" | "counts" | "recording">>;

export function NotesPanelView<Note extends NoteRowFacts>({
  notes,
  error,
  activeNoteId,
  workspaceId,
  onOpen,
  onCreate,
  badge,
  emptyText,
  errorText,
  searchPlaceholder,
}: {
  notes: readonly Note[] | null;
  error: boolean;
  activeNoteId: string | null;
  workspaceId?: string;
  onOpen: (note: Note) => void;
  onCreate?: () => void;
  badge?: ReactNode;
  emptyText?: string;
  errorText?: string;
  searchPlaceholder?: string;
}) {
  const { t } = useTranslation("notes");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!notes || !q) return notes ?? [];
    return notes.filter((n) => `${n.title} ${n.excerpt ?? ""}`.toLowerCase().includes(q));
  }, [notes, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="notes-panel">
      <div className="flex h-8 shrink-0 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-app-ui-sm font-medium text-foreground">
          {t("panel.title")}
        </span>
        {badge}
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          aria-label={t("panel.search")}
          title={t("panel.search")}
          onClick={() => {
            setSearching((s) => !s);
            setQuery("");
          }}
        >
          {searching ? <X className="size-3.5" /> : <Search className="size-3.5" />}
        </button>
      </div>
      <div className={cn("flex shrink-0 flex-col gap-2 px-3", (onCreate || searching) && "pb-2")}>
        {onCreate && (
          <Button variant="outline" size="sm" className="w-full" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("panel.new")}
          </Button>
        )}
        {searching && (
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
            placeholder={searchPlaceholder ?? t("panel.searchPlaceholder")}
            className="h-7 rounded-(--radius-control) border border-border bg-transparent px-2 text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {error ? (
          <p className="px-2 py-3 text-app-ui-sm text-muted-foreground">
            {errorText ?? t("panel.loadError")}
          </p>
        ) : notes && notes.length === 0 ? (
          <p className="px-2 py-3 text-app-ui-sm text-muted-foreground">
            {emptyText ?? t("panel.empty")}
          </p>
        ) : notes && shown.length === 0 ? (
          <p className="px-2 py-3 text-app-ui-sm text-muted-foreground">{t("panel.noMatch")}</p>
        ) : (
          <>
            {shown.length > 0 && !query && (
              <div className="px-2 pt-1 pb-1 text-app-micro text-muted-foreground">
                {t("panel.recent")}
              </div>
            )}
            {shown.map((note) => (
              <NoteRow
                key={note.id}
                workspaceId={workspaceId}
                note={note}
                active={note.id === activeNoteId}
                onOpen={() => onOpen(note)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function NoteRow({
  workspaceId,
  note,
  active,
  onOpen,
}: {
  workspaceId?: string;
  note: NoteRowFacts;
  active: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation("notes");
  const recording = useRecorderStore(
    (s) =>
      workspaceId !== undefined &&
      s.phase !== "idle" &&
      s.workspaceId === workspaceId &&
      s.noteId === note.id,
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-start gap-2 rounded-(--radius-control) px-2 py-1.5 text-left",
        active ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid="note-row"
    >
      <span className="relative mt-0.5 shrink-0">
        <NotebookPen className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {recording && (
          <span
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-[var(--state-error-fg)]"
            title={t("recorder.recording")}
            data-testid="note-row-recording"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-app-body",
            note.title ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {note.title || t("panel.untitled")}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-app-micro text-muted-foreground">
          <span className="shrink-0 whitespace-nowrap">{noteTime(note.updatedAt)}</span>
          <span className="ml-auto flex min-w-0 gap-1 overflow-hidden">
            {noteChips(note).map((chip) => (
              <span
                key={chip}
                className="shrink-0 whitespace-nowrap rounded-(--radius-pill) border border-border px-1.5 leading-4"
              >
                {chip}
              </span>
            ))}
          </span>
        </span>
      </span>
    </button>
  );
}

export function noteChips(note: Pick<NoteRowFacts, "counts" | "recording">): string[] {
  if (!note.counts) return [];
  const { sketches, files, images, todos, todosDone } = note.counts;
  const t = i18next.t.bind(i18next);
  const chips: string[] = [];
  if (note.recording) {
    const meeting = note.recording.people >= 2;
    const seconds = Math.max(0, Math.floor(note.recording.ms / 1000));
    chips.push(
      seconds < 60
        ? t(meeting ? "notes:chip.meetingSeconds" : "notes:chip.recordingSeconds", { seconds })
        : t(meeting ? "notes:chip.meeting" : "notes:chip.recording", {
            minutes: Math.floor(seconds / 60),
          }),
    );
  }
  if (todos) chips.push(t("notes:chip.todos", { done: todosDone, total: todos }));
  if (sketches) chips.push(t("notes:chip.sketches", { count: sketches }));
  if (files) chips.push(t("notes:chip.files", { count: files }));
  if (images) chips.push(t("notes:chip.images", { count: images }));
  return chips.length ? chips : [t("notes:chip.text")];
}

function useActiveNoteId(workspaceId: string): string | null {
  const activeTabId = useLayoutStore((s) => {
    const layout = s.byWorkspace[workspaceId];
    if (!layout) return null;
    return findLeaf(layout.root, layout.activeGroupId)?.activeTabId ?? null;
  });
  return useTabsStore((s) => {
    if (!activeTabId) return null;
    const tab = s.byWorkspace[workspaceId]?.[activeTabId];
    return tab?.type === "note" ? tab.props.noteId : null;
  });
}
