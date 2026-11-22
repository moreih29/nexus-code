/**
 * A note's tab: its title, where it is kept, and its body, a block editor
 * (TipTap) with text, lists, to-dos, sketches drawn in place, pasted images
 * and files dropped in. It saves as it is typed in; "To an agent" opens a
 * chat that reads it with `nexus note read`. "Record" records into it, what
 * is said going into the transcript beside the text.
 */
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import i18next from "i18next";
import { Bot, FolderOpen, MoreHorizontal, ScrollText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hasBlocksAt, insertionIndex, isEmptyDoc } from "../../../shared/notes/insert";
import type { DocNode } from "../../../shared/notes/markdown";
import { hasImage, imageBlock, type NoteContent } from "../../../shared/notes/types";
import { imageExt, NoteAssetUrls, notesApi } from "../../services/notes/api";
import { noteLocation } from "../../services/notes/conversation";
import {
  createNoteDocumentInbox,
  type NoteDocumentEvent,
} from "../../services/notes/document-inbox";
import { dropRecording, useRecorderStore } from "../../services/notes/recorder";
import {
  createNoteAutoSave,
  type NoteSaveState,
  registerNoteSave,
} from "../../services/notes/save";
import {
  dropTranscript,
  loadTranscript,
  transcriptKey,
  useTranscriptsStore,
} from "../../services/notes/transcripts";
import { useNoteSummaries } from "../../services/notes/use-summaries";
import { closeNoteTabs, closeTab, openEditorTab } from "../../state/operations";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { type FileDragPayload, MIME_FILE } from "../../types/workbench-dnd";
import { Button } from "../ui/button";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { DND_FILE_SURFACE_ATTR } from "../workspace/dnd/markers";
import { NoteAnswerCards } from "./answer-cards";
import { ConversationChips, NoteConversationLinks } from "./conversation-chips";
import { applyAnswerCard } from "./editor/answer-card";
import { noteExtensions } from "./editor/extensions";
import type { NoteHost } from "./editor/host";
import { applyLineReport } from "./editor/line-report";
import { RecordControls } from "./record-controls";
import { NoteSelectionMenu } from "./selection-menu";
import { SendToAgent } from "./send-to-agent";
import { NoteSummaryBanners } from "./summary-banner";
import { sameSummaryTaskTimes, summaryTaskTimes } from "./summary-task-times";
import { NoteTaskControls } from "./task-controls";
import { TranscriptPanel, type TranscriptQuote } from "./transcript-panel";
import type { TranscriptJump } from "./transcript-rows";

/** How long after the last key typed in the title the tab takes its name. */
const TAB_TITLE_DELAY_MS = 150;

export function NoteEditor({
  workspaceId,
  tabId,
  noteId,
  isVisible,
}: {
  workspaceId: string;
  tabId: string;
  noteId: string;
  isVisible: boolean;
}) {
  const { t } = useTranslation("notes");
  const [note, setNote] = useState<NoteContent | null>(null);
  const [missing, setMissing] = useState(false);

  const location = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId);
    return workspace && noteLocation(workspace, s.workspaces);
  });
  const inbox = useMemo(
    () => createNoteDocumentInbox<NoteDocumentEvent>(location, noteId),
    [location, noteId],
  );
  useLayoutEffect(() => {
    const stopReports = notesApi.onLineReported(inbox.receive);
    const stopCards = notesApi.onBlocksAdded((event) => {
      if (event.updatedAt !== undefined) inbox.receive({ ...event, updatedAt: event.updatedAt });
    });
    return () => {
      stopCards();
      stopReports();
    };
  }, [inbox]);

  useEffect(() => {
    let alive = true;
    notesApi.read(workspaceId, noteId).then(
      (n) => {
        if (alive) setNote(n);
        // Opened, with no undo yet: the files of blocks deleted before can go.
        void notesApi.prune(workspaceId, noteId).catch(() => {});
      },
      () => alive && setMissing(true),
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, noteId]);

  if (missing)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-app-ui-sm text-muted-foreground">
        {t("editor.missing")}
        <Button variant="outline" size="sm" onClick={() => closeTab(workspaceId, tabId)}>
          {t("editor.closeTab")}
        </Button>
      </div>
    );
  if (!note)
    return (
      <div className="flex h-full items-center justify-center p-6 text-app-ui-sm text-muted-foreground">
        {t("editor.loading")}
      </div>
    );
  return (
    <NoteConversationLinks note={{ workspaceId, noteId, tabId }} isVisible={isVisible}>
      <LoadedNote
        workspaceId={workspaceId}
        tabId={tabId}
        note={note}
        isVisible={isVisible}
        receiveDocumentEvent={inbox.attach}
      />
    </NoteConversationLinks>
  );
}

function LoadedNote({
  workspaceId,
  tabId,
  note,
  isVisible,
  receiveDocumentEvent,
}: {
  workspaceId: string;
  tabId: string;
  note: NoteContent;
  isVisible: boolean;
  receiveDocumentEvent: (apply: (event: NoteDocumentEvent) => void) => () => void;
}) {
  const { t } = useTranslation("notes");
  // The title as typed. The input keeps it itself: a key typed there draws
  // nothing else again, not the header, nor the transcript beside it.
  const title = useRef(note.title);
  const [saveState, setSaveState] = useState<NoteSaveState>("saved");
  const [agentOpen, setAgentOpen] = useState(false);
  const summaries = useNoteSummaries(workspaceId, note.id, tabId, isVisible);
  const [taskTimes, setTaskTimes] = useState(() => summaryTaskTimes(note.doc));
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  // The transcript shows beside the text once the note has recordings, or records.
  const recordings = useTranscriptsStore(
    (s) => s.byNote[transcriptKey(workspaceId, note.id)]?.recordings.length ?? 0,
  );
  const recordingHere = useRecorderStore(
    (s) => s.phase !== "idle" && s.workspaceId === workspaceId && s.noteId === note.id,
  );
  const [transcriptOpen, setTranscriptOpen] = useState<boolean | null>(null);
  useEffect(() => {
    void loadTranscript(workspaceId, note.id);
  }, [workspaceId, note.id]);
  const [transcriptJump, setTranscriptJump] = useState<TranscriptJump>();
  const jumpToTranscript = useCallback((jump: TranscriptJump) => {
    setTranscriptJump(jump);
    setTranscriptOpen(true);
  }, []);
  const showTranscript = transcriptOpen ?? (recordings > 0 || recordingHere);

  // A new note starts at its title (and the "New note" button loses focus,
  // so Enter does not make another one).
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!note.title && isEmptyDoc(note.doc)) titleInput.current?.focus();
  }, [note]);

  // The tab is named after the note: once the title is opened, and a moment
  // after the last key typed in it, not at each key (naming it draws the
  // tab bars, whose menus each set state again after drawing).
  const tabTitleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameTab = useCallback(() => {
    if (tabTitleTimer.current) clearTimeout(tabTitleTimer.current);
    tabTitleTimer.current = null;
    useTabsStore.getState().setProcessTitle(workspaceId, tabId, title.current.trim() || null);
  }, [workspaceId, tabId]);
  useEffect(() => {
    nameTab();
    return () => {
      if (tabTitleTimer.current) clearTimeout(tabTitleTimer.current);
    };
  }, [nameTab]);

  const documentBase = useRef(note.updatedAt);
  const { schedule, flush, discard } = useMemo(
    () => createNoteAutoSave((change) => notesApi.save(workspaceId, note.id, change), setSaveState),
    [workspaceId, note.id],
  );
  useEffect(() => {
    const unregister = registerNoteSave(flush);
    return () => {
      void flush().finally(unregister);
    };
  }, [flush]);

  const urls = useMemo(() => new NoteAssetUrls(workspaceId, note.id), [workspaceId, note.id]);
  useEffect(() => () => urls.dispose(), [urls]);

  const editorRef = useRef<Editor | null>(null);
  const insertAssets = useCallback(
    async (
      at: number | null,
      files: { paths: string[]; images: File[]; imagePaths?: string[] },
    ) => {
      const editor = editorRef.current;
      if (!editor) return;
      try {
        const nodes: DocNode[] = [];
        for (const image of files.images) {
          const asset = await notesApi.addImage(
            workspaceId,
            note.id,
            image,
            image.name || undefined,
          );
          nodes.push(imageBlock(asset));
        }
        if (files.imagePaths?.length) {
          for (const asset of await notesApi.addFiles(workspaceId, note.id, files.imagePaths)) {
            nodes.push(imageBlock(asset));
          }
        }
        if (files.paths.length) {
          for (const asset of await notesApi.addFiles(workspaceId, note.id, files.paths)) {
            nodes.push({
              type: "noteFile",
              attrs: { src: asset.src, name: asset.name, size: asset.size },
            });
          }
        }
        if (!nodes.length) return;
        const chain = editor.chain().focus();
        (at === null ? chain.insertContent(nodes) : chain.insertContentAt(at, nodes)).run();
      } catch (e) {
        showToast({
          kind: "error",
          message: t("editor.addFailed", { message: e instanceof Error ? e.message : String(e) }),
        });
      }
    },
    [workspaceId, note.id, t],
  );

  const host = useMemo<NoteHost>(
    () => ({
      assetUrl: (src, version) => urls.get(src, version),
      readText: (src) => urls.text(src),
      saveSketch: (sketch) => notesApi.saveSketch(workspaceId, note.id, sketch),
      openAsset: (src) => void notesApi.openAsset(workspaceId, note.id, src),
      revealAsset: (src) => void notesApi.revealAsset(workspaceId, note.id, src),
      openWorkspaceFile: (path) => {
        const root = workspace?.rootPath;
        if (!root) return;
        const filePath = path.startsWith("/") ? path : `${root.replace(/\/$/, "")}/${path}`;
        openEditorTab(workspaceId, { workspaceId, filePath });
      },
      language: () => i18next.language || "en",
    }),
    [urls, workspaceId, note.id, workspace?.rootPath],
  );

  // Files dropped on the note: one from the file tree is linked where it is
  // (not copied); one from the OS is copied in, an image shown. Both go after
  // the block they are dropped on, or at the end when dropped below the text.
  const rootRef = useRef("");
  rootRef.current = (workspace?.rootPath ?? "").replace(/\/$/, "");
  const dropFiles = useRef((_at: number | null, _dt: DataTransfer): boolean => false);
  dropFiles.current = (at, dt) => {
    const editor = editorRef.current;
    if (!editor) return false;
    const place = at === null ? editor.state.doc.content.size : blockEnd(editor, at);
    const raw = dt.getData(MIME_FILE);
    if (raw) {
      let payload: FileDragPayload;
      try {
        payload = JSON.parse(raw) as FileDragPayload;
      } catch {
        return false;
      }
      const root = rootRef.current;
      const links = payload.filePaths.map((p) => {
        const rel = root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
        return {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: rel,
              marks: [{ type: "link", attrs: { href: `workspace:${rel}` } }],
            },
          ],
        };
      });
      editor.chain().focus().insertContentAt(place, links).run();
      return true;
    }
    const files = Array.from(dt.files ?? []);
    if (!files.length) return false;
    const images = files.filter((f) => imageExt(f.type));
    const paths = files
      .filter((f) => !imageExt(f.type))
      .map((f) => window.files.getPathForFile(f))
      .filter(Boolean);
    void insertAssets(place, { paths, images });
    return true;
  };

  const editor = useEditor(
    {
      extensions: noteExtensions(host, {
        placeholder: t("editor.placeholder"),
        pickFiles: async () => {
          const paths = await notesApi.pickFiles(false);
          if (paths.length) await insertAssets(null, { paths, images: [] });
        },
        pickImages: async () => {
          const imagePaths = await notesApi.pickFiles(true);
          if (imagePaths.length) await insertAssets(null, { paths: [], images: [], imagePaths });
        },
      }),
      content: note.doc as never,
      immediatelyRender: true,
      onUpdate: ({ editor: e }) => {
        const doc = e.getJSON() as DocNode;
        schedule({ doc, baseUpdatedAt: documentBase.current });
        const next = summaryTaskTimes(doc);
        setTaskTimes((previous) => (sameSummaryTaskTimes(previous, next) ? previous : next));
      },
      editorProps: {
        attributes: { class: "note-body", "data-testid": "note-body" },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length) return false;
          const images = files.filter((f) => imageExt(f.type));
          const paths = files
            .filter((f) => !imageExt(f.type))
            .map((f) => window.files.getPathForFile(f))
            .filter(Boolean);
          if (!images.length && !paths.length) return false;
          void insertAssets(null, { paths, images });
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved || !event.dataTransfer) return false;
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
          if (!dropFiles.current(at, event.dataTransfer)) return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
        handleClick: (_view, _pos, event) => {
          const a = (event.target as HTMLElement | null)?.closest?.("a");
          if (!a || !(event.metaKey || event.ctrlKey || a.closest(".note-task-report")))
            return false;
          event.preventDefault();
          const href = a.getAttribute("href") ?? "";
          if (href.startsWith("workspace:"))
            host.openWorkspaceFile(href.slice("workspace:".length));
          else if (/^https?:/.test(href)) window.open(href, "_blank");
          return true;
        },
      },
    },
    [note.id],
  );
  editorRef.current = editor;

  useLayoutEffect(() => {
    if (!editor) return;
    return receiveDocumentEvent((event) => {
      if (editor.isDestroyed || event.updatedAt <= documentBase.current) return;
      documentBase.current = event.updatedAt;
      if ("blocks" in event) {
        for (const card of event.blocks) applyAnswerCard(editor, card as unknown as DocNode);
      } else {
        applyLineReport(editor, event);
      }
    });
  }, [editor, receiveDocumentEvent]);

  // A photo from the user's phone: written at the end of the note already;
  // put in this copy too (once), which saves it with what is typed here.
  useEffect(() => {
    return notesApi.onPhotoAdded((event) => {
      const e = editorRef.current;
      if (event.noteId !== note.id || !e || e.isDestroyed) return;
      if (!hasImage(e.getJSON() as DocNode, event.src)) {
        e.chain()
          .insertContentAt(e.state.doc.content.size, imageBlock(event), {
            updateSelection: false,
          })
          .run();
      }
      showToast({ kind: "info", message: t("editor.photoAdded") });
    });
  }, [note.id, t]);

  // Blocks an agent put into the note (nexus note write, add): written into
  // it already; put in this copy too, in the same place (once), which saves
  // them with what is typed here.
  useEffect(() => {
    return notesApi.onBlocksAdded((event) => {
      if (event.updatedAt !== undefined) return;
      const e = editorRef.current;
      if (event.noteId !== note.id || !e || e.isDestroyed) return;
      const blocks = event.blocks as unknown as DocNode[];
      const doc = e.getJSON() as DocNode;
      const origin = blocks[0]?.attrs?.nexusOrigin;
      if (origin && doc.content?.some((block) => block.attrs?.nexusOrigin === origin)) return;
      const chain = e.chain();
      if (origin) chain.setMeta("preventAutolink", true);
      if (isEmptyDoc(doc) && event.under === undefined) {
        chain
          .insertContentAt({ from: 0, to: e.state.doc.content.size }, blocks, {
            updateSelection: false,
          })
          .run();
        return;
      }
      // A heading renamed here since: at the end, rather than nowhere.
      const index = insertionIndex(doc, event.under) ?? e.state.doc.childCount;
      if (hasBlocksAt(doc, index, blocks)) return;
      let pos = 0;
      for (let i = 0; i < index; i++) pos += e.state.doc.child(i).nodeSize;
      chain.insertContentAt(pos, blocks, { updateSelection: false }).run();
    });
  }, [note.id]);

  useEffect(() => {
    return notesApi.onBlocksRemoved((event) => {
      const e = editorRef.current;
      if (event.noteId !== note.id || !e || e.isDestroyed) return;
      const ranges: Array<{ from: number; to: number }> = [];
      e.state.doc.forEach((block, from) => {
        if (block.attrs.nexusOrigin === event.origin) {
          ranges.push({ from, to: from + block.nodeSize });
        }
      });
      if (!ranges.length) return;
      const tr = e.state.tr;
      for (const { from, to } of ranges.reverse()) tr.delete(from, to);
      e.view.dispatch(tr);
    });
  }, [note.id]);

  const typeTitle = (value: string) => {
    title.current = value;
    schedule({ title: value });
    if (tabTitleTimer.current) clearTimeout(tabTitleTimer.current);
    tabTitleTimer.current = setTimeout(nameTab, TAB_TITLE_DELAY_MS);
  };
  const titleNow = useCallback(() => title.current.trim() || t("panel.untitled"), [t]);

  const remove = async () => {
    const ok = await showConfirmDialog({
      title: t("editor.deleteConfirm.title", { title: titleNow() }),
      description: t("editor.deleteConfirm.description"),
      confirmLabel: t("editor.deleteConfirm.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    discard();
    dropRecording(workspaceId, note.id);
    await notesApi.remove(workspaceId, note.id);
    dropTranscript(workspaceId, note.id);
    closeNoteTabs(workspaceId, note.id);
  };

  /** A transcript line into the note, as a quote: who, when, what. */
  const quote = useCallback(
    (q: TranscriptQuote) => {
      if (!editor) return;
      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", marks: [{ type: "bold" }], text: q.speaker },
                  { type: "text", text: ` (${q.time}) ${q.text}` },
                ],
              },
            ],
          },
          { type: "paragraph" },
        ])
        .run();
    },
    [editor],
  );
  const hideTranscript = useCallback(() => {
    setTranscriptOpen(false);
    setTranscriptJump(undefined);
  }, []);

  const place = { workspaceId, noteId: note.id, tabId };
  return (
    <div
      className="@container/note flex h-full min-h-0 flex-col bg-[var(--surface-island-bg,transparent)]"
      data-testid="note-editor"
    >
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-border px-6 pt-3 pb-2.5">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <input
            ref={titleInput}
            defaultValue={note.title}
            onChange={(e) => typeTitle(e.target.value)}
            onBlur={nameTab}
            onKeyDown={(e) => {
              // Enter that ends a syllable being composed (Korean, Japanese) stays here.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                editor?.commands.focus("start");
              }
            }}
            placeholder={t("editor.titlePlaceholder")}
            className="w-full bg-transparent text-[17px] font-semibold text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="note-title"
          />
          <span className="flex min-w-0 items-center text-app-micro text-muted-foreground">
            <span className="truncate">
              {workspace?.name ?? ""} · {t("editor.kept")} ·&nbsp;
            </span>
            <span className="shrink-0" aria-live="polite">
              {saveState === "saving"
                ? t("editor.saving")
                : saveState === "error"
                  ? t("editor.saveError")
                  : t("editor.saved")}
            </span>
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!showTranscript && (recordings > 0 || recordingHere) && (
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
          <RecordControls
            workspaceId={workspaceId}
            noteId={note.id}
            onStart={() => setTranscriptOpen(true)}
          />
          <SendToAgent
            open={agentOpen}
            onOpenChange={setAgentOpen}
            workspaceId={workspaceId}
            cwd={workspace?.rootPath ?? ""}
            noteId={note.id}
            title={titleNow}
            beforeSend={flush}
            trigger={
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) border border-border px-2.5 text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)]"
                data-testid="note-to-agent"
              >
                <Bot className="size-3.5" aria-hidden="true" />
                {t("editor.toAgent")}
              </button>
            }
          />
          <DropdownMenuRoot>
            <DropdownMenuTrigger>
              <button
                type="button"
                aria-label={t("editor.more")}
                title={t("editor.more")}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void notesApi.revealNote(workspaceId, note.id)}>
                <span className="flex items-center gap-2">
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  {t("editor.reveal")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void remove()}>
                <span className="flex items-center gap-2">
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("editor.delete")}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </div>
      </div>
      <ConversationChips />
      <NoteSummaryBanners
        workspaceId={workspaceId}
        noteId={note.id}
        summaries={summaries}
        flush={flush}
      />
      {/* The transcript beside the text where the tab is wide, under it where it is narrow. */}
      <div className="flex min-h-0 flex-1 flex-col @min-[720px]/note:flex-row">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; the editor in it takes the keyboard */}
        <div
          className="note-doc relative min-h-0 min-w-0 flex-1 overflow-y-auto px-7 pt-4"
          {...{ [DND_FILE_SURFACE_ATTR]: "" }}
          onDragOver={(e) => {
            const types = e.dataTransfer.types;
            if (types.includes(MIME_FILE) || types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            // Below or beside the text, where the editor itself does not take it.
            if (e.defaultPrevented) return;
            if (dropFiles.current(null, e.dataTransfer)) e.preventDefault();
          }}
        >
          <EditorContent editor={editor} className="h-full" />
          {editor && workspace && (
            <>
              <NoteAnswerCards editor={editor} />
              <NoteSelectionMenu
                editor={editor}
                workspaceId={workspaceId}
                cwd={workspace.rootPath}
                noteId={note.id}
                title={titleNow}
                flush={flush}
              />
            </>
          )}
          {editor && (
            <NoteTaskControls
              editor={editor}
              note={place}
              title={titleNow}
              flush={flush}
              onTranscript={jumpToTranscript}
            />
          )}
        </div>
        {showTranscript && (
          <TranscriptPanel
            workspaceId={workspaceId}
            noteId={note.id}
            summaries={summaries}
            taskTimes={taskTimes}
            flushNote={flush}
            jump={transcriptJump}
            onQuote={quote}
            onClose={hideTranscript}
          />
        )}
      </div>
    </div>
  );
}

/** Where a block dropped at `at` goes: after the top-level block there. */
function blockEnd(editor: Editor, at: number): number {
  const $pos = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
  return $pos.depth === 0 ? $pos.pos : $pos.after(1);
}
