"use no memo";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { selectFlat, useFilesStore } from "../../state/stores/files";
import { isInEditable } from "../../keybindings/global";
import { openOrRevealEditor } from "../../services/editor";
import { FileTreeRow } from "./file-tree-row";
import { computeParentJumpIndex } from "./keys";

interface FileTreeProps {
  workspaceId: string;
  rootAbsPath: string;
}

export function FileTree({ workspaceId, rootAbsPath }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Subscribe to the workspace's tree slice; recompute the flat list only when
  // that slice's reference changes. selectFlat always returns a fresh array of
  // fresh wrapper objects, so any selector with reference comparison (Object.is
  // or shallow element-wise) would forceStoreRerender on every store tick and
  // trigger "Maximum update depth exceeded". Using `tree` as the useMemo dep
  // keeps the flat array stable between unrelated store updates.
  const tree = useFilesStore((s) => s.trees.get(workspaceId));
  const flat = useMemo(() => {
    if (!tree) return [];
    return selectFlat(useFilesStore.getState(), workspaceId);
  }, [tree, workspaceId]);

  // ensureRoot on mount/workspaceId change
  useEffect(() => {
    useFilesStore.getState().ensureRoot(workspaceId, rootAbsPath);
  }, [workspaceId, rootAbsPath]);

  // 200ms loading delay state
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    const isLoading = tree?.loading.has(rootAbsPath) ?? false;
    if (!isLoading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(t);
  }, [tree, rootAbsPath]);

  const [activeIndex, setActiveIndex] = useState(0);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 24,
    overscan: 10,
  });

  // Empty/loading/error branches
  const rootError = tree?.errors.get(rootAbsPath);
  if (flat.length === 0) {
    if (rootError) {
      return (
        <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
          Couldn't read this folder.
          <div className="mt-1 text-micro text-stone-gray">{toUserMessage(rootError)}</div>
          <button
            type="button"
            onClick={() => useFilesStore.getState().refresh(workspaceId)}
            className="mt-3 underline text-foreground hover:text-foreground/80"
          >
            Retry
          </button>
        </div>
      );
    }
    if (showLoading) {
      return (
        <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">Loading…</div>
      );
    }
    if (tree && !tree.loading.has(rootAbsPath)) {
      return (
        <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
          This folder is empty.
        </div>
      );
    }
    return null; // pre-200ms hidden
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const item = flat[activeIndex];
    if (!item) return;
    const isDir = item.node.type === "dir";

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(flat.length - 1, activeIndex + 1);
      setActiveIndex(next);
      virtualizer.scrollToIndex(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      virtualizer.scrollToIndex(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (isDir && !tree?.expanded.has(item.absPath)) {
        useFilesStore.getState().toggleExpand(workspaceId, item.absPath);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isDir && tree?.expanded.has(item.absPath)) {
        useFilesStore.getState().toggleExpand(workspaceId, item.absPath);
      } else {
        const parentIdx = computeParentJumpIndex(flat, item, rootAbsPath);
        if (parentIdx !== null) {
          setActiveIndex(parentIdx);
          virtualizer.scrollToIndex(parentIdx);
        }
      }
    } else if (e.key === "Enter" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      if (isInEditable(e.target as HTMLElement)) return;
      if (isDir) return;
      e.preventDefault();
      openOrRevealEditor(
        { workspaceId, filePath: item.absPath },
        { newSplit: { orientation: "horizontal", side: "after" } },
      );
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isDir) {
        useFilesStore.getState().toggleExpand(workspaceId, item.absPath);
      } else {
        openOrRevealEditor({ workspaceId, filePath: item.absPath });
      }
    }
  }

  function handleRowClick(idx: number, item: (typeof flat)[number]) {
    setActiveIndex(idx);
    if (item.node.type === "dir") {
      useFilesStore.getState().toggleExpand(workspaceId, item.absPath);
    } else {
      openOrRevealEditor({ workspaceId, filePath: item.absPath });
    }
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="h-full overflow-auto focus:outline-none"
    >
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const item = flat[vi.index];
          if (!item) return null;
          const isExpanded = tree?.expanded.has(item.absPath) ?? false;
          return (
            <div
              key={item.absPath}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: 24,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <FileTreeRow
                node={item.node}
                depth={item.depth}
                isExpanded={isExpanded}
                isSelected={vi.index === activeIndex}
                isLoading={tree?.loading.has(item.absPath) ?? false}
                onToggle={() => handleRowClick(vi.index, item)}
                onClick={() => handleRowClick(vi.index, item)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function toUserMessage(err: string): string {
  if (err.includes("ENOENT")) return "Folder not found.";
  if (err.includes("EACCES")) return "Permission denied.";
  return "Unexpected error.";
}
