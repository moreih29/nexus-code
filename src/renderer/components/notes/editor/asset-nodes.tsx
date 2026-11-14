/**
 * A note's pasted images and the files put into it: blocks that point at a
 * file in the note's folder (screens/, materials/).
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import { FileText, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { NoteHost } from "./host";

export interface AssetNodeOptions {
  host: NoteHost | null;
}

export const NoteImage = Node.create<AssetNodeOptions>({
  name: "noteImage",
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({ host: null }),
  addAttributes: () => ({ src: { default: "" }, alt: { default: "" } }),
  parseHTML: () => [{ tag: "figure[data-note-image]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "figure",
    mergeAttributes(HTMLAttributes, { "data-note-image": "" }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

export const NoteFile = Node.create<AssetNodeOptions>({
  name: "noteFile",
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({ host: null }),
  addAttributes: () => ({ src: { default: "" }, name: { default: "" }, size: { default: 0 } }),
  parseHTML: () => [{ tag: "div[data-note-file]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-note-file": "" }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
});

function useAssetUrl(host: NoteHost | null, src: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (host && src)
      void host.assetUrl(src).then(
        (u) => alive && setUrl(u),
        () => alive && setUrl(null),
      );
    return () => {
      alive = false;
    };
  }, [host, src]);
  return url;
}

function ImageView({ node, selected, extension }: ReactNodeViewProps) {
  const host = (extension.options as AssetNodeOptions).host;
  const src = String(node.attrs.src ?? "");
  const url = useAssetUrl(host, src);
  return (
    <NodeViewWrapper className="my-1" data-drag-handle>
      <img
        src={url ?? undefined}
        alt={String(node.attrs.alt ?? "")}
        draggable={false}
        onDoubleClick={() => host?.openAsset(src)}
        className={cn(
          "block max-h-[480px] max-w-full rounded-(--radius-control) border border-border",
          selected && "ring-2 ring-ring",
        )}
      />
    </NodeViewWrapper>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function FileView({ node, selected, extension }: ReactNodeViewProps) {
  const { t } = useTranslation("notes");
  const host = (extension.options as AssetNodeOptions).host;
  const src = String(node.attrs.src ?? "");
  const name = String(node.attrs.name || src.split("/").pop() || "");
  const size = Number(node.attrs.size) || 0;
  return (
    <NodeViewWrapper className="my-1" data-drag-handle>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a block of the editor, which selects it; a double-click opens the file, as the menu does */}
      <div
        className={cn(
          "group inline-flex max-w-full items-center gap-2.5 rounded-(--radius-control) border border-border px-3 py-2",
          "bg-[var(--surface-island-bg)] hover:bg-[var(--state-hover-bg)]",
          selected && "ring-2 ring-ring",
        )}
        onDoubleClick={() => host?.openAsset(src)}
        title={t("file.openHint")}
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-app-body text-foreground">{name}</span>
          <span className="text-app-micro text-muted-foreground">
            {formatBytes(size)} · {t("file.copied")}
          </span>
        </span>
        <button
          type="button"
          className="ml-1 hidden size-6 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:text-foreground group-hover:inline-flex"
          aria-label={t("file.reveal")}
          title={t("file.reveal")}
          onClick={() => host?.revealAsset(src)}
        >
          <FolderOpen className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </NodeViewWrapper>
  );
}
