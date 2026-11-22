import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_LIST_ENTRIES } from "../../../../packages/remote-protocol/src/rpc";
import { ipcCallResult } from "../../ipc/client";
import { refreshPeerSessions } from "../../services/remote/room";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { copyText } from "../../utils/clipboard";
import { peerPathKey, peerRelativePath } from "../../utils/peer-path";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "../files/file-tree/metrics";
import { FileTreeRow } from "../files/file-tree/row";
import { FileTreeVirtualBody } from "../files/file-tree/virtual-body";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { IconButton } from "../ui/icon-button";
import { changedPeerGitParents, peerGitDecorations } from "./git-tree";
import {
  loadPeerFolder,
  type PeerFolderError,
  type PeerTreeEntry,
  peerTreeRows,
} from "./tree-model";

const FOCUS_REFRESH_LIMIT = 20;

type RefreshTree = (
  scope?: { start: number; end: number; queue: boolean } | { parents: ReadonlySet<string> },
) => void;

export function PeerFileTree({
  target,
  canRead,
  rejoin,
  sessionHint,
}: {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  rejoin: number;
  sessionHint: number;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, workspace } = target;
  const id = peerTargetId(target);
  const root = workspace.path;
  const view = usePeerWorkspaceStore((s) => s.views[id] ?? EMPTY_PEER_VIEW);
  const rootKey = peerPathKey(root);
  const gitStatus = view.gitStatus;
  const decorations = useMemo(() => peerGitDecorations(root, gitStatus), [root, gitStatus]);
  // The root starts expanded. Keep an explicit collapse in the same in-memory tree as the folders.
  const collapsedRoot = view.expanded.has(rootKey);
  const [errors, setErrors] = useState<Readonly<Record<string, PeerFolderError>>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState(rootKey);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const rowIdPrefix = useId();
  const rows = peerTreeRows({ root, title: workspace.name, ...view, collapsedRoot, errors });
  const rowId = (key: string) => `${rowIdPrefix}-${encodeURIComponent(key)}`;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  const readFolder = useRef<(key: string, path: string) => void>(() => {});
  const refreshTree = useRef<RefreshTree>(() => {});
  const refreshVisible = useRef<() => void>(() => {});
  const previousGit = useRef(gitStatus);
  const previousSessionHint = useRef(sessionHint);
  const currentErrors = useRef(errors);
  useEffect(() => {
    currentErrors.current = errors;
  }, [errors]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a rejoin invalidates the in-flight reads
  useEffect(() => {
    if (!canRead) return;
    setPending(new Set());
    const controller = new AbortController();
    const { signal } = controller;
    const inFlight = new Set<string>();
    const queued = new Set<string>();
    const load = async (key: string, path: string, queue = false) => {
      if (inFlight.has(key)) {
        if (queue) queued.add(key);
        return;
      }
      inFlight.add(key);
      setPending(new Set(inFlight));
      const result = await loadPeerFolder(() =>
        ipcCallResult("remote", "peerFilesList", { deviceId, workspaceId, path }, { signal }),
      );
      if (signal.aborted) return;
      inFlight.delete(key);
      setPending(new Set(inFlight));
      const store = usePeerWorkspaceStore.getState();
      if ("folder" in result) {
        store.setFolder(id, key, result.folder);
        setErrors((before) => {
          const next = { ...before };
          delete next[key];
          return next;
        });
      } else if (result.error === "missingWorkspace") {
        store.markMissing(id);
        refreshPeerSessions(deviceId);
        return;
      } else {
        if (result.error === "missingFolder") store.setFolder(id, key, null);
        const error = result.error;
        setErrors((before) => ({ ...before, [key]: error }));
      }
      if (queued.delete(key)) void load(key, path);
    };
    readFolder.current = (key, path) => void load(key, path);
    refreshTree.current = (scope) => {
      const current = usePeerWorkspaceStore.getState().views[id] ?? EMPTY_PEER_VIEW;
      const rows = peerTreeRows({
        ...current,
        root,
        title: "",
        collapsedRoot: current.expanded.has(rootKey),
        errors: currentErrors.current,
      });
      const folders = rows.filter(
        (row): row is PeerTreeEntry =>
          row.kind === "entry" &&
          row.node.type === "dir" &&
          (row.parent === null ? !current.expanded.has(rootKey) : current.expanded.has(row.key)),
      );
      if (!scope) {
        void load(rootKey, current.folders[rootKey]?.path ?? root);
        for (const folder of folders) {
          if (folder.parent !== null) void load(folder.key, folder.path);
        }
        return;
      }
      if ("parents" in scope) {
        for (const folder of folders) {
          if (scope.parents.has(folder.key)) void load(folder.key, folder.path, true);
        }
        return;
      }

      const byKey = new Map(folders.map((folder) => [folder.key, folder]));
      const visible = new Set<string>();
      for (const row of rows.slice(scope.start, scope.end)) {
        const key = row.kind === "entry" ? row.key : row.folder;
        if (byKey.has(key)) visible.add(key);
        if (row.kind === "entry" && row.parent !== null) visible.add(row.parent);
      }
      for (const key of [...visible].slice(0, FOCUS_REFRESH_LIMIT)) {
        const folder = byKey.get(key);
        if (folder) void load(folder.key, folder.path, scope.queue);
      }
    };
    const refreshViewport = (queue: boolean) => {
      const element = scroll.current;
      if (document.visibilityState === "hidden" || !element) return;
      refreshTree.current({
        start: Math.floor(element.scrollTop / ROW_HEIGHT_PX),
        end: Math.ceil((element.scrollTop + element.clientHeight) / ROW_HEIGHT_PX),
        queue,
      });
    };
    const onFocus = () => refreshViewport(false);
    refreshVisible.current = () => refreshViewport(true);
    if (usePeerWorkspaceStore.getState().views[id]?.folders[rootKey]) onFocus();
    else void load(rootKey, root);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      readFolder.current = () => {};
      refreshTree.current = () => {};
      refreshVisible.current = () => {};
      window.removeEventListener("focus", onFocus);
    };
  }, [canRead, deviceId, id, rejoin, root, rootKey, workspaceId]);

  useEffect(() => {
    if (!canRead || previousSessionHint.current === sessionHint) return;
    previousSessionHint.current = sessionHint;
    refreshVisible.current();
  }, [canRead, sessionHint]);

  useEffect(() => {
    if (!canRead || previousGit.current === gitStatus) return;
    const previous = previousGit.current;
    previousGit.current = gitStatus;
    if (!previous) return;
    const parents = changedPeerGitParents(root, previous, gitStatus);
    if (parents.size > 0) refreshTree.current({ parents });
  }, [canRead, gitStatus, root]);

  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === focused),
  );
  const activeRow = rows[activeIndex];
  function isExpanded(row: PeerTreeEntry): boolean {
    return row.parent === null ? !collapsedRoot : view.expanded.has(row.key);
  }
  function toggle(row: PeerTreeEntry) {
    usePeerWorkspaceStore.getState().toggleFolder(id, row.key);
    if (!isExpanded(row) && (!view.folders[row.key] || errors[row.key])) {
      readFolder.current(row.key, row.path);
    }
  }
  function activate(row: PeerTreeEntry) {
    if (row.node.type === "dir") toggle(row);
    if (row.node.type === "file") {
      const alreadyOpen = view.tabs.find(
        (tab) => tab.type === "peer.file" && peerPathKey(tab.path) === row.key,
      );
      if (canRead || alreadyOpen) {
        usePeerWorkspaceStore.getState().openFile(id, alreadyOpen?.path ?? row.path);
      }
    }
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || activeRow?.kind !== "entry") return;
    let next = activeIndex;
    switch (event.key) {
      case "Enter":
      case " ":
        activate(activeRow);
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        for (let index = activeIndex + delta; index >= 0 && index < rows.length; index += delta) {
          if (rows[index].kind === "entry") {
            next = index;
            break;
          }
        }
        break;
      }
      case "ArrowRight": {
        const child = rows[activeIndex + 1];
        if (activeRow.node.type === "dir") {
          if (!isExpanded(activeRow)) toggle(activeRow);
          else if (child?.kind === "entry" && child.parent === activeRow.key) next++;
        }
        break;
      }
      case "ArrowLeft":
        if (activeRow.node.type === "dir" && isExpanded(activeRow)) toggle(activeRow);
        else if (activeRow.parent !== null)
          next = rows.findIndex((row) => row.key === activeRow.parent);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.findLastIndex((row) => row.kind === "entry");
        break;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) return;
        const row = document.getElementById(rowId(activeRow.key));
        const rect = row?.getBoundingClientRect();
        row?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: rect?.left,
            clientY: rect?.bottom,
          }),
        );
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next !== activeIndex && rows[next]) {
      setFocused(rows[next].key);
      virtualizer.scrollToIndex(next);
    }
  }

  return (
    <ContextMenuRoot>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 justify-end border-b border-border/50 px-1">
          <IconButton
            label={t("files:fileTree.header.refresh")}
            size="sm"
            disabled={!canRead}
            onClick={() => refreshTree.current()}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </IconButton>
        </div>
        <ContextMenuTrigger>
          <div
            ref={scroll}
            role="tree"
            aria-label={t("files:panel.tab.tree")}
            aria-activedescendant={activeRow ? rowId(activeRow.key) : undefined}
            tabIndex={0}
            onKeyDown={navigate}
            onContextMenu={(event) => {
              if (!(event.target instanceof Element) || !event.target.closest("[role=treeitem]")) {
                event.preventDefault();
              }
            }}
            className="app-scrollbar min-h-0 flex-1 overflow-auto focus-visible:outline-none"
          >
            <FileTreeVirtualBody
              virtualizer={virtualizer}
              renderRow={(index) => {
                const row = rows[index];
                if (!row) return null;
                if (row.kind !== "entry") {
                  const label =
                    row.kind === "truncated"
                      ? t("peerWorkspace.truncated", { count: MAX_LIST_ENTRIES })
                      : row.kind === "error"
                        ? t(`peerWorkspace.${errors[row.folder]}`)
                        : canRead
                          ? t("editor.loading")
                          : null;
                  return (
                    label && (
                      <div
                        role="status"
                        className="flex h-full items-center truncate text-app-micro text-muted-foreground"
                        style={{ paddingLeft: indentPaddingLeft(row.depth) }}
                      >
                        {label}
                      </div>
                    )
                  );
                }
                const current = view.activePath && peerPathKey(view.activePath) === row.key;
                return (
                  <FileTreeRow
                    id={rowId(row.key)}
                    absPath={row.path}
                    node={row.node}
                    depth={row.depth}
                    isExpanded={isExpanded(row)}
                    isFocused={activeIndex === index}
                    isSelected={Boolean(current)}
                    isLoading={canRead && pending.has(row.key)}
                    decoration={(row.node.type === "dir"
                      ? decorations.folders
                      : decorations.files
                    ).get(row.key)}
                    onClick={() => {
                      scroll.current?.focus({ preventScroll: true });
                      setFocused(row.key);
                      activate(row);
                    }}
                    onContextMenu={() => {
                      setFocused(row.key);
                      setMenuPath(row.path);
                    }}
                  />
                );
              }}
            />
          </div>
        </ContextMenuTrigger>
      </div>
      {menuPath !== null && (
        <ContextMenuContent>
          <ContextMenuItems
            items={[
              {
                kind: "item",
                label: t("files:fileTree.menu.copyPath"),
                onSelect: () => copyText(menuPath),
              },
              {
                kind: "item",
                label: t("files:fileTree.menu.copyRelativePath"),
                onSelect: () =>
                  copyText(peerRelativePath(menuPath, view.folders[rootKey]?.path ?? root)),
              },
            ]}
          />
        </ContextMenuContent>
      )}
    </ContextMenuRoot>
  );
}
