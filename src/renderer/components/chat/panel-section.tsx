import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

const folds = new Map<string, boolean>();

export function useFold(key: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => folds.get(key) ?? initial);
  const [shown, setShown] = useState(key);
  if (shown !== key) {
    setShown(key);
    setOpen(folds.get(key) ?? initial);
  }
  const set = useCallback(
    (next: boolean) => {
      folds.set(key, next);
      setOpen(next);
    },
    [key],
  );
  return [open, set];
}

const REVEAL_FOLLOW_MS = 1500;

function scrollToTop(el: HTMLElement): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY === "auto" || overflowY === "scroll") {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      return;
    }
  }
}

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

export const FIRST_FEW = 3;

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
          className="self-start whitespace-nowrap rounded-(--radius-control) px-1 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
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
  empty = false,
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
  empty?: boolean;
  folded?: boolean;
  onOpen?: () => void;
  openAgain?: unknown;
  reveal?: number;
  onRevealed?: (seq: number) => void;
  opened?: number;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(!folded);
  useEffect(() => {
    if (opened !== undefined) setOpen(true);
  }, [opened]);
  const ref = useRef<HTMLElement>(null);
  const [scrollFor, setScrollFor] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked for each time it opens, not when the callback changes
  useEffect(() => {
    if (open && !empty) onOpen?.();
  }, [open, empty, openAgain]);
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
    const observer = new ResizeObserver(() => scrollToTop(el));
    observer.observe(el);
    const timer = setTimeout(() => observer.disconnect(), REVEAL_FOLLOW_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollFor]);
  const shown = open && !empty;
  return (
    <section ref={ref} className="border-b border-border px-3 py-2">
      <button
        type="button"
        onClick={empty ? undefined : () => setOpen(!open)}
        aria-expanded={empty ? undefined : shown}
        aria-disabled={empty || undefined}
        className={cn(
          "flex w-full items-center gap-1 text-left text-app-ui-sm text-muted-foreground",
          empty ? "cursor-default" : "hover:text-foreground",
        )}
        data-empty={empty || undefined}
      >
        {shown ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className={cn("size-3.5 shrink-0", empty && "opacity-40")} />
        )}
        <span className={cn("min-w-0 truncate", !empty && "font-medium")}>{title}</span>
        {count !== undefined && (
          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">{count}</span>
        )}
      </button>
      {shown && <div className="mt-1.5 flex flex-col gap-0.5">{children}</div>}
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
