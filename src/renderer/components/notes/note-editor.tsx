/**
 * A note's tab: its title, where it is kept, and its body, a block editor
 * (TipTap) with text, lists, to-dos, sketches drawn in place, pasted images
 * and files dropped in. It saves as it is typed in; "To an agent" opens a
 * chat that reads it with `nexus note read`.
 */
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import i18next from "i18next";
import { Bot, FolderOpen, MoreHorizontal, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { THEME_SOURCE_BY_ID } from "../../../shared/design-tokens/theme-sources";
import type { DocNode } from "../../../shared/notes/markdown";
import type { NoteContent } from "../../../shared/notes/types";
import { imageExt, NoteAssetUrls, notesApi } from "../../services/notes/api";
import { closeNoteTabs, closeTab, openEditorTab } from "../../state/operations";
import { useTabsStore } from "../../state/stores/tabs";
import { useThemeStore } from "../../state/stores/theme";
import { useWorkspacesStore } from "../../state/stores/workspaces";
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
import { type FileDragPayload, MIME_FILE } from "../workspace/dnd/types";
import { noteExtensions } from "./editor/extensions";
import type { NoteHost } from "./editor/host";
import { SendToAgent } from "./send-to-agent";

const SAVE_DELAY_MS = 500;

type SaveState = "saved" | "saving" | "error";

export function NoteEditor({
  workspaceId,
  tabId,
  noteId,
}: {
  workspaceId: string;
  tabId: string;
  noteId: string;
}) {
  const { t } = useTranslation("notes");
  const [note, setNote] = useState<NoteContent | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    notesApi.read(workspaceId, noteId).then(
      (n) => alive && setNote(n),
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
  return <LoadedNote workspaceId={workspaceId} tabId={tabId} note={note} />;
}

function LoadedNote({
  workspaceId,
  tabId,
  note,
}: {
  workspaceId: string;
  tabId: string;
  note: NoteContent;
}) {
  const { t } = useTranslation("notes");
  const [title, setTitle] = useState(note.title);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [agentOpen, setAgentOpen] = useState(false);
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const theme = useThemeStore((s) => s.resolved);
  const dark = THEME_SOURCE_BY_ID[theme]?.base === "dark";
  const darkRef = useRef(dark);
  darkRef.current = dark;

  // A new note starts at its title (and the "New note" button loses focus,
  // so Enter does not make another one).
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!note.title && isEmptyDoc(note.doc)) titleRef.current?.focus();
  }, [note]);

  // The tab is named after the note.
  useEffect(() => {
    useTabsStore.getState().setProcessTitle(workspaceId, tabId, title.trim() || null);
  }, [workspaceId, tabId, title]);

  // Saving: the latest title and document, a moment after the last change.
  const pending = useRef<{ title?: string; doc?: DocNode }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const change = pending.current;
    pending.current = {};
    if (change.title === undefined && change.doc === undefined) return;
    setSaveState("saving");
    try {
      await notesApi.save(workspaceId, note.id, change);
      setSaveState("saved");
    } catch {
      pending.current = { ...change, ...pending.current };
      setSaveState("error");
    }
  }, [workspaceId, note.id]);
  const schedule = useCallback(
    (change: { title?: string; doc?: DocNode }) => {
      pending.current = { ...pending.current, ...change };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );
  useEffect(() => () => void flush(), [flush]);

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
          nodes.push({ type: "noteImage", attrs: { src: asset.src, alt: asset.name } });
        }
        if (files.imagePaths?.length) {
          for (const asset of await notesApi.addFiles(workspaceId, note.id, files.imagePaths)) {
            nodes.push({ type: "noteImage", attrs: { src: asset.src, alt: asset.name } });
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
      isDark: () => darkRef.current,
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
      onUpdate: ({ editor: e }) => schedule({ doc: e.getJSON() as DocNode }),
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
          if (!a || !(event.metaKey || event.ctrlKey)) return false;
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

  const remove = async () => {
    const ok = await showConfirmDialog({
      title: t("editor.deleteConfirm.title", { title: title.trim() || t("panel.untitled") }),
      description: t("editor.deleteConfirm.description"),
      confirmLabel: t("editor.deleteConfirm.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    if (timer.current) clearTimeout(timer.current);
    pending.current = {};
    await notesApi.remove(workspaceId, note.id);
    closeNoteTabs(workspaceId, note.id);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--surface-island-bg,transparent)]"
      data-testid="note-editor"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-6 pt-3 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              schedule({ title: e.target.value });
            }}
            onKeyDown={(e) => {
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
        <SendToAgent
          open={agentOpen}
          onOpenChange={setAgentOpen}
          workspaceId={workspaceId}
          cwd={workspace?.rootPath ?? ""}
          noteId={note.id}
          title={title.trim() || t("panel.untitled")}
          beforeSend={flush}
          trigger={
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-border px-2.5 text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)]"
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
              <FolderOpen className="size-3.5" aria-hidden="true" />
              {t("editor.reveal")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void navigator.clipboard.writeText(`nexus note read ${note.id}`)}
            >
              <Terminal className="size-3.5" aria-hidden="true" />
              {t("editor.copyCommand")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void remove()}>
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("editor.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; the editor in it takes the keyboard */}
      <div
        className="note-doc min-h-0 flex-1 overflow-y-auto px-7 pt-4"
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
      </div>
    </div>
  );
}

/** Whether a document has nothing in it (no blocks, or one empty paragraph). */
function isEmptyDoc(doc: DocNode): boolean {
  const blocks = doc.content ?? [];
  return (
    blocks.length === 0 ||
    (blocks.length === 1 && blocks[0]?.type === "paragraph" && !blocks[0].content?.length)
  );
}

/** Where a block dropped at `at` goes: after the top-level block there. */
function blockEnd(editor: Editor, at: number): number {
  const $pos = editor.state.doc.resolve(Math.min(at, editor.state.doc.content.size));
  return $pos.depth === 0 ? $pos.pos : $pos.after(1);
}
