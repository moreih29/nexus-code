// The parts a chat's side panel is made of: a section that folds, opens
// when a bare command asks for it and comes into view; its rows; a long
// list's first few rows; and a row the conversation asks to see.

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

/** How long a section a bare command opened keeps itself at the top as it fills. */
const REVEAL_FOLLOW_MS = 1500;

/**
 * Scrolls the panel so a section starts at its top, moving only the panel:
 * scrollIntoView would move every box around it that can scroll.
 */
function scrollToTop(el: HTMLElement): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY === "auto" || overflowY === "scroll") {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      return;
    }
  }
}

/** Scrolls the panel just far enough to show all of a row, or its start when it is taller. */
function scrollIntoPanel(el: HTMLElement): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const row = el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (row.top < view.top || row.height > view.height) box.scrollTop += row.top - view.top;
    else if (row.bottom > view.bottom) box.scrollTop += row.bottom - view.bottom;
    return;
  }
}

/**
 * A row the conversation asked for (a job its end names): it opens, comes
 * into view and is lit for a moment, which tells which of the rows was meant.
 * Each ask (`reveal`, its seq) once.
 */
export function useRevealedRow(
  reveal: number | undefined,
  open: () => void,
  onRevealed?: (seq: number) => void,
): { ref: React.RefObject<HTMLDivElement | null>; lit: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, not when the callbacks change
  useEffect(() => {
    if (reveal === undefined) return;
    open();
    setLit(reveal);
    onRevealed?.(reveal);
  }, [reveal]);
  useEffect(() => {
    const el = ref.current;
    if (lit === null || !el) return;
    scrollIntoPanel(el);
    // What it shows opened comes a moment later and makes it taller: it follows for a while.
    const observer = new ResizeObserver(() => scrollIntoPanel(el));
    observer.observe(el);
    const timer = setTimeout(() => {
      observer.disconnect();
      setLit(null);
    }, REVEAL_FOLLOW_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [lit]);
  return { ref, lit: lit !== null };
}

/** How many rows of a long list (the jobs, the results) show before the rest is asked for. */
export const FIRST_FEW = 3;

/**
 * The first few rows of a list (`first`, FIRST_FEW by default), the rest
 * behind a button that counts them. `opened`, set when a row among the rest
 * was asked for, shows them all.
 */
export function FirstFew({
  first = FIRST_FEW,
  opened,
  children,
}: {
  first?: number;
  opened?: number;
  children: React.ReactNode[];
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (opened !== undefined) setAll(true);
  }, [opened]);
  const rest = children.length - first;
  return (
    <>
      {all || rest <= 0 ? children : children.slice(0, first)}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="self-start rounded-(--radius-control) px-1 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          data-testid="panel-first-few"
        >
          {all ? t("chat.panel.less") : t("chat.panel.more", { count: rest })}
        </button>
      )}
    </>
  );
}

export function Section({
  title,
  count,
  headless = false,
  folded = false,
  onOpen,
  openAgain,
  reveal,
  onRevealed,
  opened,
  children,
}: {
  title: string;
  count?: number | string;
  /** Shown with no heading, always open: a section with only a line of its own (RunningSection). */
  headless?: boolean;
  /** Starts folded. */
  folded?: boolean;
  /** Called each time the section opens. */
  onOpen?: () => void;
  /** Called again, while open, when this changes: as the program comes up. */
  openAgain?: unknown;
  /** Set when a bare command asked for this section: it opens and comes into view. */
  reveal?: number;
  onRevealed?: (seq: number) => void;
  /** Set when one of its rows was asked for: it opens, and the row shows itself. */
  opened?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!folded);
  useEffect(() => {
    if (opened !== undefined) setOpen(true);
  }, [opened]);
  const ref = useRef<HTMLElement>(null);
  // The ask to scroll to, once the section has opened: before, the panel
  // may be too short to bring it to the top.
  const [scrollFor, setScrollFor] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked for each time it opens, not when the callback changes
  useEffect(() => {
    if (open) onOpen?.();
  }, [open, openAgain]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, not when the callback changes
  useEffect(() => {
    if (reveal === undefined) return;
    setOpen(true);
    setScrollFor(reveal);
    onRevealed?.(reveal);
  }, [reveal]);
  useEffect(() => {
    const el = ref.current;
    if (scrollFor === null || !el) return;
    scrollToTop(el);
    // What it shows may come a moment later (the MCP servers, the usage),
    // and only then can the panel scroll far enough: it follows for a while.
    const observer = new ResizeObserver(() => scrollToTop(el));
    observer.observe(el);
    const timer = setTimeout(() => observer.disconnect(), REVEAL_FOLLOW_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollFor]);
  return (
    <section ref={ref} className="border-b border-border px-3 py-2">
      {!headless && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1 text-left text-app-ui-sm text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="font-medium">{title}</span>
          {count !== undefined && <span className="ml-auto tabular-nums">{count}</span>}
        </button>
      )}
      {/* In the same place headed or not, so what it holds stays as it is when that changes. */}
      {(open || headless) && (
        <div className={cn("flex flex-col gap-0.5", !headless && "mt-1.5")}>{children}</div>
      )}
    </section>
  );
}

export function Row({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-6 items-center gap-2 text-app-ui-sm", className)} title={title}>
      {children}
    </div>
  );
}
