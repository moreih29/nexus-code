import { Folder, GitBranch, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";
import { tooltipProps } from "../ui/tooltip";

export type RowPlace =
  | { readonly kind: "branch"; readonly name: string; readonly hint?: string }
  | {
      readonly kind: "workspace";
      readonly name: string;
      readonly color?: string;
      readonly hint?: string;
    };

export function rowShellClass({
  attention,
  selected,
}: {
  attention: boolean;
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
  sign?: ReactNode;
  time?: string | null;
  timeHint?: string;
  urgent?: boolean;
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
        <span
          className="min-w-0 flex-1 truncate text-foreground"
          {...tooltipProps(titleHint ?? title)}
        >
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
              {...(timeHint ? tooltipProps(timeHint) : {})}
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

export function DeviceTag({ name }: { name: string }) {
  return (
    <span
      className="flex max-w-24 min-w-0 shrink-[2] items-center gap-1"
      {...tooltipProps(name)}
      data-testid="session-row-device"
    >
      <Monitor aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function PlaceTag({ place, testId }: { place: RowPlace; testId?: string }) {
  return (
    <span
      className={cn(
        "flex max-w-40 min-w-0 items-center gap-1",
        place.kind === "branch" && "font-mono",
      )}
      {...tooltipProps(place.hint ?? place.name)}
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
