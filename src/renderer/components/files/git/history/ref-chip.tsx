/**
 * Ref chips render compact git decorations beside a commit subject and expose
 * branch/tag navigation without changing the row context-menu behavior.
 */
import { GitBranch, Tag } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LogEntryRef } from "../../../../../shared/git/types";
import { cn } from "../../../../utils/cn";
import { useDismissOnOutsideClickMulti } from "../../../ui/use-dismiss-on-outside-click";

const DEFAULT_VISIBLE_REF_COUNT = 2;
const POPOVER_WIDTH_PX = 220;
const POPOVER_MAX_HEIGHT_PX = 240;

export type RefChipDisplayKind = "head" | "current" | "branch" | "remote" | "tag";
export type RefChipVisibleCount = 1 | 2;
export type RefChipListBreakpoint = "narrow" | "medium" | "wide";
export type RefChipContextMenuHandler = (
  event: React.MouseEvent<HTMLElement>,
  refInfo?: LogEntryRef,
) => void;

export interface RefChipProps {
  readonly refInfo: LogEntryRef;
  readonly currentRefName?: string;
  readonly role?: React.AriaRole;
  readonly className?: string;
  readonly iconOnly?: boolean;
  readonly onRefChange: (refName: string) => void;
  readonly onOpenMenu?: RefChipContextMenuHandler;
}

export interface RefChipListProps {
  readonly refs: readonly LogEntryRef[] | undefined;
  readonly currentRefName?: string;
  readonly breakpoint?: RefChipListBreakpoint;
  readonly visibleCount?: RefChipVisibleCount;
  readonly onRefChange: (refName: string) => void;
  readonly onOpenMenu?: RefChipContextMenuHandler;
}

/** Renders one focusable ref decoration chip with a 14ch truncation cap. */
export function RefChip({
  refInfo,
  currentRefName,
  role,
  className,
  iconOnly = false,
  onRefChange,
  onOpenMenu,
}: RefChipProps) {
  const displayKind = refChipDisplayKind(refInfo, currentRefName);
  const showIconOnly = iconOnly && displayKind === "head";

  /** Navigates to the chip ref without also selecting the commit row. */
  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onRefChange(refInfo.name);
  }

  /** Keeps right-clicks on chips wired to the existing commit menu. */
  function handleContextMenu(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu?.(event, refInfo);
  }

  return (
    <button
      type="button"
      role={role}
      title={refInfo.name}
      className={cn(refChipClassName(displayKind, showIconOnly), className)}
      aria-label={refChipAriaLabel(refInfo, displayKind)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <RefChipIcon displayKind={displayKind} />
      {showIconOnly ? null : <span className="min-w-0 truncate">{refInfo.name}</span>}
    </button>
  );
}

/** Renders prioritized visible ref chips plus a portal popover for overflow. */
export function RefChipList({
  refs,
  currentRefName,
  breakpoint,
  visibleCount = DEFAULT_VISIBLE_REF_COUNT,
  onRefChange,
  onOpenMenu,
}: RefChipListProps) {
  const popoverId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPoint, setPopoverPoint] = useState<PopoverPoint | null>(null);
  const orderedRefs = useMemo(
    () => sortRefsForDisplay(refs ?? [], currentRefName),
    [currentRefName, refs],
  );
  const normalizedVisibleCount = visibleCountForBreakpoint(breakpoint, visibleCount);
  const headRef = orderedRefs.find(
    (refInfo) => refChipDisplayKind(refInfo, currentRefName) === "head",
  );
  const visibleRefs = orderedRefs.slice(0, normalizedVisibleCount);
  const overflowRefs = orderedRefs.slice(normalizedVisibleCount);
  const popoverOpen = popoverPoint !== null;
  const closePopover = useCallback(() => setPopoverPoint(null), []);

  useDismissOnOutsideClickMulti([wrapperRef, popoverRef], popoverOpen, closePopover);

  useEffect(() => {
    if (!popoverOpen) return;

    /** Closes the overflow menu with the conventional Escape key. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") closePopover();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePopover, popoverOpen]);

  if (orderedRefs.length === 0) return null;
  if (breakpoint === "narrow") {
    if (!headRef) return null;
    return (
      <span ref={wrapperRef} className="inline-flex min-w-0 items-center">
        <RefChip
          refInfo={headRef}
          currentRefName={currentRefName}
          iconOnly
          onRefChange={onRefChange}
          onOpenMenu={onOpenMenu}
        />
      </span>
    );
  }

  /** Toggles the overflow popover at the overflow trigger location. */
  function handleOverflowClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setPopoverPoint((current) =>
      current ? null : { x: rect.left, y: rect.bottom + 4, triggerWidth: rect.width },
    );
  }

  /** Forwards right-click on the overflow trigger to the commit menu. */
  function handleOverflowContextMenu(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    closePopover();
    onOpenMenu?.(event);
  }

  return (
    <span ref={wrapperRef} className="inline-flex min-w-0 items-center gap-1">
      {visibleRefs.map((refInfo) => (
        <RefChip
          key={refChipKey(refInfo)}
          refInfo={refInfo}
          currentRefName={currentRefName}
          onRefChange={onRefChange}
          onOpenMenu={onOpenMenu}
        />
      ))}
      {overflowRefs.length > 0 ? (
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center rounded-full border border-[var(--color-git-chip-border)] px-2 text-app-ui-xs text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Show ${overflowRefs.length} more refs`}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          aria-controls={popoverOpen ? popoverId : undefined}
          onClick={handleOverflowClick}
          onContextMenu={handleOverflowContextMenu}
        >
          +{overflowRefs.length}
        </button>
      ) : null}
      {popoverOpen && popoverPoint ? (
        <RefChipOverflowPopover
          id={popoverId}
          point={popoverPoint}
          refs={overflowRefs}
          currentRefName={currentRefName}
          popoverRef={popoverRef}
          onRefChange={(refName) => {
            closePopover();
            onRefChange(refName);
          }}
          onClose={closePopover}
          onOpenMenu={onOpenMenu}
        />
      ) : null}
    </span>
  );
}

/** Sorts refs by the agreed display priority while preserving Git order ties. */
export function sortRefsForDisplay(
  refs: readonly LogEntryRef[],
  currentRefName?: string,
): LogEntryRef[] {
  return refs
    .map((refInfo, index) => ({
      refInfo,
      index,
      priority: refChipPriority(refChipDisplayKind(refInfo, currentRefName)),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ refInfo }) => refInfo);
}

/** Maps schema refs into the five visual chip kinds used by the history row. */
export function refChipDisplayKind(
  refInfo: LogEntryRef,
  currentRefName?: string,
): RefChipDisplayKind {
  if (refInfo.kind === "head") return "head";
  if (refInfo.kind === "branch" && (refInfo.isHead || refInfo.name === currentRefName)) {
    return "current";
  }
  return refInfo.kind;
}

interface PopoverPoint {
  readonly x: number;
  readonly y: number;
  readonly triggerWidth: number;
}

interface RefChipOverflowPopoverProps {
  readonly id: string;
  readonly point: PopoverPoint;
  readonly refs: readonly LogEntryRef[];
  readonly currentRefName?: string;
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly onRefChange: (refName: string) => void;
  readonly onClose: () => void;
  readonly onOpenMenu?: RefChipContextMenuHandler;
}

/** Portal-renders overflow refs so row clipping cannot hide the popover. */
function RefChipOverflowPopover({
  id,
  point,
  refs,
  currentRefName,
  popoverRef,
  onRefChange,
  onClose,
  onOpenMenu,
}: RefChipOverflowPopoverProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverRef}
      id={id}
      role="menu"
      aria-label="More refs"
      className="fixed z-50 flex max-w-[240px] flex-col gap-1 overflow-y-auto rounded border border-border bg-popover p-1 text-popover-foreground shadow-none"
      style={popoverPositionStyle(point)}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      {refs.map((refInfo) => (
        <RefChip
          key={refChipKey(refInfo)}
          refInfo={refInfo}
          currentRefName={currentRefName}
          role="menuitem"
          className="w-full max-w-none justify-start"
          onRefChange={onRefChange}
          onOpenMenu={(event, openedRef) => {
            onClose();
            onOpenMenu?.(event, openedRef);
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

/** Renders the icon/marker that differentiates the five chip display kinds. */
function RefChipIcon({ displayKind }: { displayKind: RefChipDisplayKind }) {
  if (displayKind === "head") {
    return <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />;
  }
  if (displayKind === "tag") {
    return (
      <Tag className="size-3 shrink-0" aria-hidden="true" style={refChipIconStyle(displayKind)} />
    );
  }
  return (
    <GitBranch
      className="size-3 shrink-0"
      aria-hidden="true"
      style={refChipIconStyle(displayKind)}
    />
  );
}

/** Returns the restrained shape/fill treatment for one visual ref kind. */
function refChipClassName(displayKind: RefChipDisplayKind, iconOnly = false): string {
  const baseClassName = cn(
    "inline-flex h-5 min-w-0 shrink-0 items-center border text-app-ui-xs leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    iconOnly ? "w-5 justify-center px-0" : "max-w-[14ch] gap-1 px-2",
  );

  if (displayKind === "head") {
    return cn(
      baseClassName,
      "rounded-full border-transparent bg-[var(--color-git-chip-head-bg)] text-[var(--color-git-chip-head-fg)]",
    );
  }

  if (displayKind === "current") {
    return cn(
      baseClassName,
      "rounded-full border-[var(--color-git-chip-border-strong)] bg-[var(--color-git-chip-hover-bg)] text-foreground hover:bg-[var(--color-git-chip-hover-bg)]",
    );
  }

  if (displayKind === "remote") {
    return cn(
      baseClassName,
      "rounded-md border-dashed border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
    );
  }

  if (displayKind === "tag") {
    return cn(
      baseClassName,
      "rounded-[3px] border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
    );
  }

  return cn(
    baseClassName,
    "rounded-full border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
  );
}

/** Assigns secondary warm accent colors without making color the sole signal. */
function refChipIconStyle(displayKind: RefChipDisplayKind): React.CSSProperties {
  if (displayKind === "current") return { color: "var(--color-git-lane-0)" };
  if (displayKind === "branch") return { color: "var(--color-git-lane-2)" };
  if (displayKind === "remote") return { color: "var(--color-git-lane-4)" };
  return { color: "var(--color-git-lane-6)" };
}

/** Builds the descriptive label screen readers hear for one chip. */
function refChipAriaLabel(refInfo: LogEntryRef, displayKind: RefChipDisplayKind): string {
  if (displayKind === "head") return "HEAD ref";
  if (displayKind === "current") return `Current branch ${refInfo.name}`;
  if (displayKind === "branch") return `Branch ${refInfo.name}`;
  if (displayKind === "remote") return `Remote branch ${refInfo.name}`;
  return `Tag ${refInfo.name}`;
}

/** Gives stable keys to refs that may share a display name across namespaces. */
function refChipKey(refInfo: LogEntryRef): string {
  return `${refInfo.kind}:${refInfo.name}`;
}

/** Converts display kind into sort priority for HEAD/current/local/remote/tag. */
function refChipPriority(displayKind: RefChipDisplayKind): number {
  if (displayKind === "head") return 0;
  if (displayKind === "current") return 1;
  if (displayKind === "branch") return 2;
  if (displayKind === "remote") return 3;
  return 4;
}

/** Adapts visible ref density to the measured history list width. */
function visibleCountForBreakpoint(
  breakpoint: RefChipListBreakpoint | undefined,
  visibleCount: RefChipVisibleCount,
): RefChipVisibleCount {
  if (breakpoint === "medium") return 1;
  if (breakpoint === "wide") return DEFAULT_VISIBLE_REF_COUNT;
  return visibleCount === 1 ? 1 : DEFAULT_VISIBLE_REF_COUNT;
}

/** Positions the portal popover inside the viewport near the overflow chip. */
function popoverPositionStyle(point: PopoverPoint): React.CSSProperties {
  if (typeof window === "undefined") {
    return { left: point.x, top: point.y, minWidth: point.triggerWidth };
  }

  return {
    left: Math.max(4, Math.min(point.x, window.innerWidth - POPOVER_WIDTH_PX)),
    top: Math.max(4, Math.min(point.y, window.innerHeight - POPOVER_MAX_HEIGHT_PX)),
    minWidth: point.triggerWidth,
    maxHeight: POPOVER_MAX_HEIGHT_PX,
  };
}
