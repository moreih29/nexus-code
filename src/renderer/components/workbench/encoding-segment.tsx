// encoding-segment.tsx — the status bar's encoding item.
//
// Shows the encoding the active editor's file was read in: UTF-8, or the
// one its bytes were decoded in (text-encoding.ts). Clicking it opens a
// menu to reopen the file in another encoding, or to save it in one, which
// it is then in from that save on. A file with edits cannot be reopened:
// that would throw them away. A file outside the workspace only shows it.

import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { findLeaf } from "@/engine";
import { cn } from "@/utils/cn";
import type { EditorInput } from "../../services/editor";
import {
  encodingInfo,
  TEXT_ENCODINGS,
  type TextEncoding,
} from "../../services/editor/encoding/text-encoding";
import {
  getResolvedModel,
  reloadModelFromDisk,
  subscribeModel,
} from "../../services/editor/model/cache";
import { isDirty, subscribeFileDirty } from "../../services/editor/model/dirty-tracker";
import { setEncodingOverride } from "../../services/editor/model/file-loader";
import { reportSaveFailure, saveModelInteractive } from "../../services/editor/save/service";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

/** The file of the workspace's active editor, if it has one on disk. */
function useActiveEditorInput(workspaceId: string): EditorInput | null {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId]);
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  const tabId = layout ? findLeaf(layout.root, layout.activeGroupId)?.activeTabId : undefined;
  const tab = tabId ? tabs?.[tabId] : undefined;
  const props = tab?.type === "editor" ? tab.props : undefined;
  return useMemo(
    () =>
      props && props.origin !== "untitled"
        ? {
            workspaceId: props.workspaceId,
            filePath: props.filePath,
            origin: props.origin,
            readOnly: props.readOnly,
          }
        : null,
    [props],
  );
}

interface FileEncodingState {
  encoding: TextEncoding;
  cacheUri: string;
  readOnly: boolean;
  dirty: boolean;
}

/** The encoding of `input`'s model, kept current as it is reread and saved. */
function useFileEncoding(input: EditorInput | null): FileEncodingState | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!input) return;
    const rerender = () => setTick((n) => n + 1);
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The editor makes the model as it mounts, which may be after this.
    const attach = (tries: number) => {
      const resolved = getResolvedModel(input);
      if (!resolved) {
        if (tries > 0) timer = setTimeout(() => attach(tries - 1), 250);
        return;
      }
      const offModel = subscribeModel(input, rerender);
      const offDirty = subscribeFileDirty(resolved.cacheUri, rerender);
      unsubscribe = () => {
        offModel();
        offDirty();
      };
      rerender();
    };
    attach(40);
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [input]);
  if (!input) return null;
  const resolved = getResolvedModel(input);
  if (!resolved) return null;
  return {
    encoding: resolved.encoding,
    cacheUri: resolved.cacheUri,
    readOnly: resolved.readOnly,
    dirty: isDirty(resolved.cacheUri),
  };
}

const ITEM_CLASS =
  "inline-flex items-center gap-1 h-full px-2 text-app-ui-sm font-sans leading-none";

export function EncodingSegment({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const input = useActiveEditorInput(workspaceId);
  const state = useFileEncoding(input);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // A new file in the editor closes the menu of the last.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on a new file
  useEffect(() => setOpen(false), [state?.cacheUri]);

  if (!input || !state) return null;
  const name = encodingInfo(state.encoding).name;
  const title = t("encoding.segmentTitle", { name });

  if (input.origin === "external") {
    return (
      <span title={title} className={cn(ITEM_CLASS, "text-muted-foreground/70")}>
        {name}
      </span>
    );
  }

  return (
    <div ref={wrapperRef} className="relative inline-flex h-full">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          ITEM_CLASS,
          "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
        )}
      >
        <span className="truncate max-w-40">{name}</span>
      </button>
      {open ? (
        <EncodingPopover
          input={input}
          state={state}
          wrapperRef={wrapperRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-2 py-1 rounded-(--radius-control) text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none";

type Mode = "reopen" | "save";

function EncodingPopover({
  input,
  state,
  wrapperRef,
  onClose,
}: {
  input: EditorInput;
  state: FileEncodingState;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode | null>(null);

  useDismissOnOutsideClick(wrapperRef, true, onClose);

  const groups = useMemo(() => {
    const byGroup = new Map<string, (typeof TEXT_ENCODINGS)[number][]>();
    for (const encoding of TEXT_ENCODINGS) {
      const list = byGroup.get(encoding.group) ?? [];
      list.push(encoding);
      byGroup.set(encoding.group, list);
    }
    return [...byGroup];
  }, []);

  function choose(encoding: TextEncoding): void {
    onClose();
    if (mode === "reopen") {
      setEncodingOverride(input, encoding);
      void reloadModelFromDisk(input);
    } else {
      void saveModelInteractive(input, { encoding }).then(reportSaveFailure);
    }
  }

  return (
    <div
      role="dialog"
      aria-label={t("encoding.menuTitle")}
      className={cn(
        "absolute bottom-full right-0 z-(--layer-in-panel) mb-1",
        "w-[260px] max-w-[min(260px,calc(100vw-2rem))]",
        "floating-panel p-1 flex flex-col max-h-[60vh]",
      )}
    >
      {mode === null ? (
        <>
          <div className="px-2 pt-1 pb-1.5 flex flex-col gap-0.5">
            <span className="text-app-ui-sm text-foreground font-medium">
              {t("encoding.menuTitle")}
            </span>
            <span className="text-app-ui-sm text-muted-foreground">
              {encodingInfo(state.encoding).name}
            </span>
          </div>
          <div className="h-px bg-border my-1" />
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            disabled={state.dirty}
            title={state.dirty ? t("encoding.reopenDirty") : undefined}
            onClick={() => setMode("reopen")}
          >
            {t("encoding.reopen")}
          </button>
          {state.dirty && (
            <span className="px-2 pb-1 text-app-ui-sm text-muted-foreground">
              {t("encoding.reopenDirty")}
            </span>
          )}
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            disabled={state.readOnly}
            onClick={() => setMode("save")}
          >
            {t("encoding.saveWith")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={cn(MENU_ITEM_CLASS, "font-medium")}
            onClick={() => setMode(null)}
          >
            <ChevronLeft className="size-3 shrink-0" aria-hidden="true" />
            {mode === "reopen" ? t("encoding.reopen") : t("encoding.saveWith")}
          </button>
          <div className="h-px bg-border my-1" />
          <div className="overflow-y-auto min-h-0">
            {groups.map(([group, encodings]) => (
              <div key={group}>
                <div className="px-2 pt-1.5 pb-0.5 text-app-ui-sm text-muted-foreground">
                  {t(`encoding.group.${group}`)}
                </div>
                {encodings.map((encoding) => (
                  <button
                    key={encoding.id}
                    type="button"
                    className={MENU_ITEM_CLASS}
                    aria-current={encoding.id === state.encoding ? "true" : undefined}
                    onClick={() => choose(encoding.id)}
                  >
                    <Check
                      className={cn(
                        "size-3 shrink-0",
                        encoding.id === state.encoding ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                    {encoding.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
