/**
 * A sketch block: a drawing among a note's text, drawn where it is. At rest
 * it is its picture (sketches/<id>.svg); clicked, it becomes an Excalidraw
 * canvas in place, with its tools on top, its height dragged from the
 * bottom edge, and a full-screen button for a bigger drawing. Each change is
 * saved (the scene and the picture); "Done", or a click outside, puts it
 * back to rest.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import i18next from "i18next";
import { Maximize2, Minimize2, Pencil } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { showToast } from "../../ui/toast";
import type { AssetNodeOptions } from "./asset-nodes";
import type { NoteHost } from "./host";
import type { SketchApi, SketchScene } from "./sketch-canvas";
import { useDarkTheme } from "./use-dark-theme";

const SketchCanvas = lazy(() => import("./sketch-canvas"));

export const SKETCH_MIN_HEIGHT = 160;
export const SKETCH_MAX_HEIGHT = 1200;
const SAVE_DELAY_MS = 600;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sketch: {
      /** Puts a new sketch here, open to draw in. */
      insertSketch: () => ReturnType;
    };
  }
}

export const Sketch = Node.create<AssetNodeOptions>({
  name: "sketch",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addOptions: () => ({ host: null }),
  addAttributes: () => ({
    id: { default: null },
    src: { default: "" },
    title: { default: "" },
    height: { default: 320 },
    /** Opens it to draw in as soon as it shows (a sketch just inserted). */
    autoEdit: { default: false, rendered: false },
  }),
  parseHTML: () => [{ tag: "div[data-sketch]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-sketch": "" }),
  ],
  addCommands() {
    return {
      insertSketch:
        () =>
        ({ commands }) =>
          commands.insertContent([
            { type: "sketch", attrs: { autoEdit: true } },
            { type: "paragraph" },
          ]),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(SketchView, {
      // While it is drawn in, every event in it is Excalidraw's, not the text editor's.
      stopEvent: ({ event }) =>
        Boolean((event.target as HTMLElement | null)?.closest?.("[data-sketch-editing]")),
    });
  },
});

function SketchView({ node, updateAttributes, selected, extension, editor }: ReactNodeViewProps) {
  const { t } = useTranslation("notes");
  const host = (extension.options as AssetNodeOptions).host;
  const id = (node.attrs.id as string | null) ?? undefined;
  const src = String(node.attrs.src ?? "");
  const [editing, setEditing] = useState(Boolean(node.attrs.autoEdit));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (node.attrs.autoEdit) updateAttributes({ autoEdit: false });
  }, [node.attrs.autoEdit, updateAttributes]);

  return (
    <NodeViewWrapper className="my-2" data-sketch-block>
      {editing && host ? (
        <SketchEditor
          host={host}
          id={id}
          height={Number(node.attrs.height) || 320}
          onSaved={(saved) => {
            if (saved.id !== id || saved.src !== src)
              updateAttributes({ id: saved.id, src: saved.src });
            setVersion((v) => v + 1);
          }}
          onHeight={(height) => updateAttributes({ height })}
          onDone={() => {
            setEditing(false);
            editor.commands.focus();
          }}
        />
      ) : (
        <SketchPicture
          host={host}
          src={src}
          version={version}
          selected={selected}
          label={t("sketch.edit")}
          empty={t("sketch.empty")}
          onEdit={() => editor.isEditable && setEditing(true)}
        />
      )}
    </NodeViewWrapper>
  );
}

function SketchPicture({
  host,
  src,
  version,
  selected,
  label,
  empty,
  onEdit,
}: {
  host: NoteHost | null;
  src: string;
  version: number;
  selected: boolean;
  label: string;
  empty: string;
  onEdit: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [blank, setBlank] = useState(false);
  useEffect(() => {
    let alive = true;
    if (host && src)
      void host.assetUrl(src, version).then(
        (u) => alive && setUrl(u),
        () => alive && setUrl(null),
      );
    return () => {
      alive = false;
    };
  }, [host, src, version]);
  const dark = useDarkTheme();
  return (
    <button
      type="button"
      className={cn(
        "group relative inline-block max-w-full cursor-pointer rounded-(--radius-control) p-0 text-left",
        "outline-offset-4 hover:outline hover:outline-1 hover:outline-border",
        selected && "outline outline-2 outline-ring",
      )}
      onClick={onEdit}
      tabIndex={-1}
      title={label}
    >
      {url && !blank ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="block max-w-full"
          style={dark ? { filter: "invert(93%) hue-rotate(180deg)" } : undefined}
          onLoad={(e) => setBlank(e.currentTarget.naturalWidth === 0)}
        />
      ) : (
        <span className="flex h-16 w-72 items-center justify-center rounded-(--radius-control) border border-dashed border-border text-app-ui-sm text-muted-foreground">
          {empty}
        </span>
      )}
      <span className="pointer-events-none absolute top-1.5 right-1.5 hidden items-center gap-1.5 rounded-(--radius-control) border border-border bg-popover px-2 py-1 text-app-ui-sm text-foreground shadow-md group-hover:inline-flex">
        <Pencil className="size-3" aria-hidden="true" />
        {label}
      </span>
    </button>
  );
}

function SketchEditor({
  host,
  id,
  height,
  onSaved,
  onHeight,
  onDone,
}: {
  host: NoteHost;
  id: string | undefined;
  height: number;
  onSaved: (saved: { id: string; src: string }) => void;
  onHeight: (height: number) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("notes");
  const dark = useDarkTheme();
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<SketchApi | null>(null);
  const [initial, setInitial] = useState<string | null | undefined>(id ? undefined : null);
  const [full, setFull] = useState(false);
  const [h, setH] = useState(height);
  const pending = useRef<SketchScene | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sketchId = useRef(id);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const loadedVersion = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void host.readText(`sketches/${id}.excalidraw`).then((text) => alive && setInitial(text));
    return () => {
      alive = false;
    };
  }, [host, id]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const scene = pending.current;
    pending.current = null;
    if (!scene) return saving.current;
    saving.current = saving.current.then(async () => {
      try {
        const { exportSketch } = await import("./sketch-canvas");
        const out = await exportSketch(scene);
        const saved = await host.saveSketch({ id: sketchId.current, ...out });
        sketchId.current = saved.id;
        onSavedRef.current(saved);
      } catch (e) {
        console.warn("[notes] sketch not saved", e);
        showToast({
          kind: "error",
          message: i18next.t("notes:sketch.saveFailed", {
            message: e instanceof Error ? e.message : String(e),
          }),
        });
      }
    });
    return saving.current;
  }, [host]);

  const onChange = useCallback(
    (scene: SketchScene) => {
      // Excalidraw calls onChange for every pointer move; only a changed scene is saved.
      const v = scene.elements.reduce((sum, e) => sum + e.version, 0) + scene.elements.length;
      if (loadedVersion.current === null) {
        loadedVersion.current = v;
        return;
      }
      if (v === loadedVersion.current) return;
      loadedVersion.current = v;
      pending.current = scene;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const done = useCallback(() => {
    void flush().finally(() => onDoneRef.current());
  }, [flush]);

  // A click outside it is done too.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || box.current?.contains(target) || target.closest(".excalidraw")) return;
      done();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [done]);

  useEffect(() => () => void flush(), [flush]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new size (`full`, `h`) has Excalidraw measure again
  useEffect(() => {
    api.current?.refresh();
  }, [full, h]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = h;
    let last = startH;
    const move = (ev: PointerEvent) => {
      last = Math.min(SKETCH_MAX_HEIGHT, Math.max(SKETCH_MIN_HEIGHT, startH + ev.clientY - startY));
      setH(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onHeight(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={box}
      data-sketch-editing=""
      contentEditable={false}
      className={cn(
        "relative rounded-(--radius-control) border border-ring/70 shadow-[0_0_0_3px_var(--state-focus-ring,transparent)]",
        full && "fixed inset-3 z-50 bg-background shadow-2xl",
      )}
      style={full ? undefined : { height: h }}
    >
      <div className="absolute inset-0 overflow-hidden rounded-(--radius-control)">
        {initial !== undefined && (
          <Suspense fallback={null}>
            <SketchCanvas
              initial={initial}
              dark={dark}
              language={host.language()}
              onApi={(a) => {
                api.current = a;
              }}
              onChange={onChange}
            />
          </Suspense>
        )}
      </div>
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-(--radius-control) border border-border bg-popover text-foreground hover:bg-[var(--state-hover-bg)]"
          aria-label={full ? t("sketch.exitFull") : t("sketch.full")}
          title={full ? t("sketch.exitFull") : t("sketch.full")}
          onClick={() => setFull((f) => !f)}
        >
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-(--radius-control) bg-primary px-3 text-app-ui-sm text-primary-foreground hover:opacity-90"
          onClick={done}
        >
          {t("sketch.done")}
        </button>
      </div>
      {!full && (
        <button
          type="button"
          tabIndex={-1}
          className="absolute -bottom-1.5 left-1/2 z-10 flex h-3 w-14 -translate-x-1/2 cursor-ns-resize items-center justify-center rounded-full border border-ring/70 bg-popover p-0"
          onPointerDown={startResize}
          title={t("sketch.resize")}
          aria-label={t("sketch.resize")}
        >
          <span className="h-0.5 w-6 rounded-full bg-muted-foreground" />
        </button>
      )}
    </div>
  );
}
