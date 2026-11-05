// PreviewFindScope — ⌘F in a preview: a find bar over it, with the match
// count, next and previous, and match case.
//
// The scope finds in the text its content draws (dom-finder.ts). A preview
// whose text is not all in the DOM puts its own finder in its place with
// usePreviewFinder: the table previews, which draw only the rows in view;
// the PDF preview, whose pages pdf.js draws as they come into view; and the
// HTML preview, whose document is in a sandboxed frame.
//
// The scope takes focus when clicked, so ⌘F, ⌘G and Escape reach it from
// anywhere in the preview; the HTML preview's frame forwards ⌘F itself.

import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  createDomFinder,
  FIND_COLORS,
  MAX_FIND_MATCHES,
} from "../../../services/editor/preview/find/dom-finder";
import { findMatches } from "../../../services/editor/preview/find/find-matches";
import { cn } from "../../../utils/cn";

/** How many matches there are, and which is current: from 1, or 0 for none. */
export interface FindResult {
  readonly total: number;
  readonly current: number;
}

/** Finds in a preview; it tells the scope what it found through `report`. */
export interface PreviewFinder {
  search(query: string, caseSensitive: boolean): void;
  move(direction: 1 | -1): void;
  clear(): void;
  /** How far down the find bar sits, in px: below a toolbar the preview has at its top. */
  readonly barTop?: number;
}

interface FindScopeValue {
  /** Puts `finder` in place of the scope's own; returns its removal. */
  register(finder: PreviewFinder): () => void;
  report(result: FindResult): void;
  open(): void;
  close(): void;
}

const FindScopeContext = createContext<FindScopeValue | null>(null);

/**
 * Makes `create`'s finder the one the enclosing scope finds with, for as
 * long as the component is mounted and `create` is the same. `report`
 * tells the scope what it found.
 */
export function usePreviewFinder(
  create: (report: (result: FindResult) => void) => PreviewFinder,
): void {
  const scope = useContext(FindScopeContext);
  useEffect(() => {
    if (!scope) return;
    const finder = create(scope.report);
    const unregister = scope.register(finder);
    return () => {
      unregister();
      finder.clear();
    };
  }, [scope, create]);
}

/** Opens and closes the enclosing scope's find bar, as ⌘F and Escape do. */
export function usePreviewFindBar(): { open(): void; close(): void } {
  const scope = useContext(FindScopeContext);
  return useMemo(() => ({ open: () => scope?.open(), close: () => scope?.close() }), [scope]);
}

let scopes = 0;

const NO_RESULT: FindResult = { total: 0, current: 0 };

export function PreviewFindScope({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<FindResult>(NO_RESULT);
  const [custom, setCustom] = useState<PreviewFinder | null>(null);
  const ownRef = useRef<PreviewFinder | null>(null);
  const nameRef = useRef("");
  if (!nameRef.current) nameRef.current = `nexus-find-${++scopes}`;

  const finder = useCallback((): PreviewFinder => {
    if (custom) return custom;
    ownRef.current ??= createDomFinder(
      () => contentRef.current,
      findMatches,
      MAX_FIND_MATCHES,
      nameRef.current,
      FIND_COLORS,
      (total, current) => setResult({ total, current }),
    );
    return ownRef.current;
  }, [custom]);

  const openBar = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    rootRef.current?.focus();
  }, []);
  const openRef = useRef(open);
  openRef.current = open;

  const value = useMemo<FindScopeValue>(
    () => ({
      register(next) {
        setCustom(next);
        return () => setCustom((now) => (now === next ? null : now));
      },
      report: setResult,
      open: openBar,
      close: () => {
        if (openRef.current) close();
      },
    }),
    [openBar, close],
  );

  // A finder put in place, or taken away, finds what the last one did.
  useEffect(() => {
    if (!open) return;
    if (custom) ownRef.current?.clear();
    const active = finder();
    const timer = setTimeout(() => active.search(query, caseSensitive), query ? 100 : 0);
    return () => clearTimeout(timer);
  }, [open, query, caseSensitive, finder, custom]);

  useEffect(() => {
    if (open) return;
    finder().clear();
    setResult(NO_RESULT);
  }, [open, finder]);

  useEffect(() => () => ownRef.current?.clear(), []);

  const move = (direction: 1 | -1) => finder().move(direction);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      openBar();
    } else if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (open && (e.key === "F3" || (mod && !e.altKey && key === "g"))) {
      e.preventDefault();
      e.stopPropagation();
      move(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <FindScopeContext.Provider value={value}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keys of the whole preview */}
      <div
        ref={rootRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn("relative flex flex-col outline-none", className)}
      >
        <div ref={contentRef} className="flex flex-col flex-1 min-h-0">
          {children}
        </div>
        {open && (
          <FindBar
            inputRef={inputRef}
            query={query}
            onQuery={setQuery}
            caseSensitive={caseSensitive}
            onCaseSensitive={setCaseSensitive}
            result={result}
            onMove={move}
            onClose={close}
            top={custom?.barTop ?? BAR_TOP}
          />
        )}
      </div>
    </FindScopeContext.Provider>
  );
}

/** How far down the find bar sits, in px. */
const BAR_TOP = 8;

const BUTTON_CLASS =
  "inline-flex items-center justify-center size-6 rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:bg-[var(--state-hover-bg)]";

function FindBar({
  inputRef,
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  result,
  onMove,
  onClose,
  top,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  caseSensitive: boolean;
  onCaseSensitive: (on: boolean) => void;
  result: FindResult;
  onMove: (direction: 1 | -1) => void;
  onClose: () => void;
  top: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const searched = query.trim() !== "";
  const count = !searched
    ? ""
    : result.total === 0
      ? t("previewFind.none")
      : t("previewFind.count", { current: result.current, total: result.total });
  return (
    <search
      className="absolute right-4 z-30 flex items-center gap-0.5 floating-panel py-1 pl-2 pr-1"
      style={{ top }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onMove(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder={t("previewFind.placeholder")}
        aria-label={t("previewFind.placeholder")}
        spellCheck={false}
        className="h-6 w-44 bg-transparent text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span
        aria-live="polite"
        className={cn(
          "min-w-16 px-1 text-right text-app-ui-sm tabular-nums whitespace-nowrap",
          searched && result.total === 0 ? "text-[var(--state-error-fg)]" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
      <button
        type="button"
        className={cn(
          BUTTON_CLASS,
          caseSensitive && "bg-[var(--state-selected-bg)] text-foreground",
        )}
        aria-pressed={caseSensitive}
        aria-label={t("previewFind.matchCase")}
        title={t("previewFind.matchCase")}
        onClick={() => onCaseSensitive(!caseSensitive)}
      >
        <CaseSensitive className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={result.total === 0}
        aria-label={t("previewFind.previous")}
        title={t("previewFind.previous")}
        onClick={() => onMove(-1)}
      >
        <ChevronUp className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={result.total === 0}
        aria-label={t("previewFind.next")}
        title={t("previewFind.next")}
        onClick={() => onMove(1)}
      >
        <ChevronDown className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        aria-label={t("previewFind.close")}
        title={t("previewFind.close")}
        onClick={onClose}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </search>
  );
}

/** A match a preview paints itself, in a line it draws. */
export interface FindMark {
  readonly start: number;
  readonly end: number;
  readonly current: boolean;
}

/** `line` with its matches painted, the current one apart and marked data-find-current. */
export function MarkedLine({
  line,
  marks,
}: {
  line: string;
  marks: readonly FindMark[];
}): React.JSX.Element {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) parts.push(line.slice(at, mark.start));
    parts.push(
      <mark
        key={mark.start}
        data-find-current={mark.current ? "" : undefined}
        className="text-inherit"
        style={{ backgroundColor: mark.current ? FIND_COLORS.current : FIND_COLORS.match }}
      >
        {line.slice(mark.start, mark.end)}
      </mark>,
    );
    at = mark.end;
  }
  if (at < line.length) parts.push(line.slice(at));
  return <>{parts}</>;
}
