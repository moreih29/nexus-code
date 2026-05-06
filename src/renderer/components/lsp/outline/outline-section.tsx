import { ChevronDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import { absolutePathToFileUri } from "../../../../shared/file-uri";
import type { EditorInput } from "../../../services/editor/types";
import { useOutlineStore } from "../../../state/stores/outline";
import { cn } from "../../../utils/cn";
import { basename } from "../../../utils/path";
import { OutlineContent, type OutlineViewState } from "./outline-content";

export const OUTLINE_REFRESH_DEBOUNCE_MS = 400;

type OutlineLoad = (uri: string, signal?: AbortSignal) => Promise<void>;
type OutlineTimerId = ReturnType<typeof setTimeout>;

interface DebouncedOutlineLoadOptions {
  uri: string;
  load: OutlineLoad;
  delayMs?: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => OutlineTimerId;
  clearTimeoutFn?: (timerId: OutlineTimerId) => void;
}

export function scheduleDebouncedOutlineLoad({
  uri,
  load,
  delayMs = OUTLINE_REFRESH_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: DebouncedOutlineLoadOptions): () => void {
  const controller = new AbortController();
  const timerId = setTimeoutFn(() => {
    load(uri, controller.signal).catch(() => {});
  }, delayMs);

  return () => {
    clearTimeoutFn(timerId);
    controller.abort();
  };
}

interface OutlineSectionProps {
  activeInput: EditorInput | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function OutlineSection({ activeInput, collapsed, onToggleCollapsed }: OutlineSectionProps) {
  const uri = activeInput ? absolutePathToFileUri(activeInput.filePath) : null;
  const entry = useOutlineStore((state) => (uri ? state.entries.get(uri) : undefined));
  const cursorPosition = useOutlineStore((state) => (uri ? state.cursorByUri.get(uri) : undefined));
  const load = useOutlineStore((state) => state.load);

  useEffect(() => {
    let cancelled = false;
    import("./model-release").then((module) => {
      if (!cancelled) module.ensureOutlineModelReleaseSubscription();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!uri || collapsed) return;
    return scheduleDebouncedOutlineLoad({ uri, load });
  }, [uri, collapsed, load]);

  const viewState = useMemo<OutlineViewState>(() => {
    if (!uri) return { phase: "idle", symbols: [] };
    if (!entry || entry.phase === "loading") {
      return { phase: "loading", symbols: entry?.symbols ?? [], cursorPosition };
    }
    if (entry.phase === "error") {
      return { phase: "error", symbols: [], errorMessage: entry.errorMessage, cursorPosition };
    }
    if (entry.symbols.length === 0) {
      return { phase: "empty", symbols: [], cursorPosition };
    }
    return { phase: "ready", symbols: entry.symbols, cursorPosition };
  }, [entry, uri, cursorPosition]);

  const title = activeInput ? basename(activeInput.filePath) : "No editor";

  return (
    <section className="flex h-full min-h-0 flex-col bg-frosted-veil" aria-label="Outline">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        className="flex h-8 shrink-0 items-center gap-2 border-b border-b-mist-border px-3 text-left text-app-ui-xs uppercase tracking-[2.4px] text-stone-gray hover:bg-frosted-veil-strong hover:text-foreground"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")}
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">Outline</span>
        <span className="min-w-0 max-w-[45%] truncate normal-case tracking-normal text-micro text-muted-foreground">
          {title}
        </span>
      </button>

      {!collapsed ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <OutlineContent
            state={viewState}
            onRetry={() => uri && load(uri, undefined, { force: true })}
          />
        </div>
      ) : null}
    </section>
  );
}
