// A conversation's row in the agent lists, the same for this computer's and
// another computer's, in the agent view and the workspace view: two lines
// of a fixed height.
// - The title line: the agent's mark, the title, its state, and how long.
// - The line under it: the computer, the place it runs (a workspace, or a
//   task's branch), its parent where the tree does not show it, what it
//   last said, and its children's chip.
// Each part of the second line ends in an ellipsis; what it last said gives
// way first and goes when it has less than three letters' room, so the line
// never grows past the list.

import { Folder, GitBranch, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

/** Where a conversation runs, as its row tells it. */
export type RowPlace =
  | { readonly kind: "branch"; readonly name: string; readonly hint?: string }
  | {
      readonly kind: "workspace";
      readonly name: string;
      /** The workspace's color, where it has one; a folder where not. */
      readonly color?: string;
      readonly hint?: string;
    };

/** A row's frame: its border while it waits on the user, and its background. */
export function rowShellClass({
  attention,
  selected,
}: {
  attention: boolean;
  /** The selected background, where the row is selected. */
  selected: string | false;
}): string {
  return cn(
    "relative w-full min-w-0 rounded-(--radius-raised) border px-2 py-1 text-app-ui-sm transition-colors",
    attention ? "border-(--state-warning-fg)/40" : "border-transparent",
    selected || cn(attention && "bg-(--state-warning-fg)/5", "hover:bg-[var(--state-hover-bg)]"),
  );
}

export function SessionRowLines({
  icon,
  title,
  titleHint,
  sign,
  time,
  timeHint,
  urgent = false,
  actions,
  device,
  place,
  placeTestId,
  parent,
  preview,
  family,
}: {
  icon: ReactNode;
  title: string;
  titleHint?: string;
  /** Its state: a glyph, or the words for a failed turn. */
  sign?: ReactNode;
  time?: string | null;
  timeHint?: string;
  /** Waiting on the user: the time in the warning color. */
  urgent?: boolean;
  /** Buttons that take the time's place under the pointer or the keyboard (a `group/row`). */
  actions?: ReactNode;
  device?: string;
  place?: RowPlace;
  placeTestId?: string;
  parent?: ReactNode;
  preview?: ReactNode;
  family?: ReactNode;
}) {
  const meta = device || place || parent;
  return (
    <div className="pointer-events-none relative flex min-w-0 flex-col">
      <div className="flex h-5 min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1 truncate text-foreground" title={titleHint ?? title}>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {sign}
          {time && (
            <span
              className={cn(
                "text-app-micro whitespace-nowrap tabular-nums",
                urgent ? "text-(--state-warning-fg)" : "text-muted-foreground",
                actions && "group-focus-within/row:hidden group-hover/row:hidden",
              )}
              title={timeHint}
            >
              {time}
            </span>
          )}
          {actions && (
            <span className="pointer-events-auto -my-1 hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
              {actions}
            </span>
          )}
        </span>
      </div>
      <div className="flex h-4 min-w-0 items-center gap-1.5 pl-5.5 text-app-micro text-muted-foreground">
        {/* What it last said goes onto a second line, out of sight, when
            less than three letters' room is left for it. */}
        <div className="flex h-4 min-w-0 flex-1 flex-wrap content-start items-center gap-x-1.5 overflow-hidden">
          {meta && (
            <span className="flex h-4 max-w-full min-w-0 shrink-0 items-center gap-1.5">
              {device && <DeviceTag name={device} />}
              {place && <PlaceTag place={place} testId={placeTestId} />}
              {parent}
            </span>
          )}
          {preview && (
            <span className="flex h-4 min-w-[3em] flex-1 basis-0 items-center overflow-hidden">
              {preview}
            </span>
          )}
        </div>
        {family}
      </div>
    </div>
  );
}

/** The computer a conversation runs on. */
export function DeviceTag({ name }: { name: string }) {
  return (
    <span
      className="flex max-w-24 min-w-0 shrink-[2] items-center gap-1"
      title={name}
      data-testid="session-row-device"
    >
      <Monitor aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Where a conversation runs: a task's branch, or a workspace by its color or a folder. */
export function PlaceTag({ place, testId }: { place: RowPlace; testId?: string }) {
  return (
    <span
      className={cn(
        "flex max-w-40 min-w-0 items-center gap-1",
        place.kind === "branch" && "font-mono",
      )}
      title={place.hint ?? place.name}
      data-testid={testId ?? "session-row-place"}
    >
      {place.kind === "branch" ? (
        <GitBranch aria-hidden className="size-3 shrink-0" />
      ) : place.color ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: place.color }}
        />
      ) : (
        <Folder aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate">{place.name}</span>
    </span>
  );
}
