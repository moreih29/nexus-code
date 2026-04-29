import { Command } from "lucide-react";
import type { CSSProperties } from "react";

import type { NexusPlatform } from "../../../common/platform";
import { cn } from "../../lib/utils";

export const TITLE_BAR_HEIGHT = 36;
export const TITLE_BAR_DARWIN_LEFT_PADDING = 78;

interface AppRegionStyle extends CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

export interface TitleBarPartProps {
  hasWorkspace: boolean;
  platform: NexusPlatform;
  onOpenCommandPalette(): void;
  onOpenWorkspace(): void;
  className?: string;
}

export function TitleBarPart({
  hasWorkspace,
  platform,
  onOpenCommandPalette,
  onOpenWorkspace,
  className,
}: TitleBarPartProps): JSX.Element {
  const leftPadding = platform === "darwin" ? TITLE_BAR_DARWIN_LEFT_PADDING : 0;
  const triggerLabel = hasWorkspace ? "Search commands" : "Open workspace…";
  const rootStyle: AppRegionStyle = {
    WebkitAppRegion: "drag",
    height: TITLE_BAR_HEIGHT,
    paddingLeft: leftPadding,
  };
  const triggerStyle: AppRegionStyle = {
    WebkitAppRegion: "no-drag",
  };

  return (
    <header
      data-component="titlebar"
      data-platform={platform}
      role="banner"
      aria-label="Application titlebar"
      className={cn(
        "flex shrink-0 items-center border-b border-border bg-background px-2 text-foreground",
        className,
      )}
      style={rootStyle}
    >
      <div aria-hidden="true" className="min-w-0 flex-1" />
      <button
        type="button"
        data-titlebar-command-trigger="true"
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+P"
        className="inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-ring"
        style={triggerStyle}
        onClick={hasWorkspace ? onOpenCommandPalette : onOpenWorkspace}
      >
        <Command aria-hidden="true" className="size-4" strokeWidth={1.75} />
        <span>{triggerLabel}</span>
        {hasWorkspace ? (
          <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            ⌘P
          </kbd>
        ) : null}
      </button>
    </header>
  );
}
