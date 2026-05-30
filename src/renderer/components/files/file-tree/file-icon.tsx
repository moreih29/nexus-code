/**
 * Theme-aware unified icon component for file and folder nodes.
 *
 * Architecture:
 *   - `resolveLucide` and `resolveMaterialIconName` live in file-icon-resolvers.ts
 *     as pure functions (no Vite-specific imports) so they can be unit-tested in Bun.
 *   - `resolveMaterial(kind, name)` below maps the iconName to a static SVG asset
 *     URL via an eager `import.meta.glob` (`?url`) — resolved synchronously so the
 *     Material `<img>` paints without a lazy/Suspense fallback swap (flicker-free,
 *     mirroring VS Code's CSS background-image-by-URL approach).
 *   - `<FileIcon>` is the single public component. It subscribes to iconThemeStore
 *     internally so consumers never need theme prop-drilling.
 *
 * Size/tone contract (design.md §14):
 *   size="sm"  → 12px (size-3)
 *   size="md"  → 14px (size-3.5)
 *   tone="sidebar" → text-[var(--sidebar-icon-fg)]
 *   tone="muted"   → text-muted-foreground
 *
 * className is layout-only (margin, shrink). Color and size are applied
 * internally. Consumers MUST NOT pass color or sizing classes.
 */

import { useIconThemeStore } from "@/state/stores/icon-theme";
import { cn } from "@/utils/cn";
import { type FileIconKind, resolveLucide, resolveMaterialIconName } from "./file-icon-resolvers";

// Re-export the resolver types and functions so callers that need them
// can import from a single location.
export type { FileIconKind };
export { resolveLucide, resolveMaterialIconName };

// ---------------------------------------------------------------------------
// Public props type
// ---------------------------------------------------------------------------

type FileIconSize = "sm" | "md";
type FileIconTone = "sidebar" | "muted";

export interface FileIconProps {
  /** What kind of node this icon represents. */
  kind: FileIconKind;
  /**
   * Filename (including extension) — required when kind="file".
   * Used by both Lucide and Material resolvers to determine the specific icon.
   */
  name?: string;
  /** Icon grid size. "sm" = 12 px (size-3), "md" = 14 px (size-3.5). Defaults to "sm". */
  size?: FileIconSize;
  /** Semantic colour token. "sidebar" uses --sidebar-icon-fg, "muted" uses text-muted-foreground. */
  tone: FileIconTone;
  /**
   * Layout-only classes: margin, shrink, etc.
   * Colour and size classes MUST NOT be passed here — they are managed internally.
   */
  className?: string;
  /** Forwarded to the rendered element for accessibility. */
  "aria-hidden"?: boolean | "true" | "false";
}

// ---------------------------------------------------------------------------
// Material SVG URL map — VS Code-style synchronous URL mapping, no per-icon
// code-splitting. Each SVG is emitted as a static asset and referenced by URL
// from an <img>. Because the URL is known synchronously (eager glob) and there
// is no lazy()/Suspense boundary, there is no Lucide→colour swap on first
// paint — that swap was the source of the visible flicker. Only the short URL
// strings live in the JS bundle; the SVG bytes load from disk on first use and
// are then browser-cached.
//
// NOTE: `?url` MUST be passed via the `query` option. A `*.svg?url` pattern is
// taken literally by Vite and matches zero files.
// ---------------------------------------------------------------------------

const MATERIAL_URL_GLOB = import.meta.glob("@/assets/icons/material/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** iconName → asset URL, derived from the eager glob at module init time. */
const MATERIAL_URL: Record<string, string> = {};
for (const [path, url] of Object.entries(MATERIAL_URL_GLOB)) {
  // Keys end with "…/<name>.svg" (the ?url query is not part of the glob key).
  const match = path.match(/\/([^/]+)\.svg(?:\?.*)?$/);
  if (match) {
    MATERIAL_URL[match[1]] = url;
  }
}

/**
 * Resolves the material SVG asset URL for a node kind/name.
 *
 * Returns the asset URL when an SVG exists, or null when the iconName from the
 * manifest has no corresponding SVG file (the handful of manifest entries that
 * ship without an asset) — the caller then renders the Lucide icon instead.
 *
 * Pure: no store access, no React state.
 */
function resolveMaterial(kind: FileIconKind, name?: string): string | null {
  const iconName = resolveMaterialIconName(kind, name);
  if (!iconName) return null;
  return MATERIAL_URL[iconName] ?? null;
}

// ---------------------------------------------------------------------------
// Box metrics
// ---------------------------------------------------------------------------

/** Pixel size per logical size token. */
const SIZE_PX: Record<FileIconSize, number> = { sm: 12, md: 14 };
/** Tailwind size class per logical size token. */
const SIZE_CLASS: Record<FileIconSize, string> = { sm: "size-3", md: "size-3.5" };
/** Tailwind colour class per tone. */
const TONE_CLASS: Record<FileIconTone, string> = {
  sidebar: "text-[var(--sidebar-icon-fg)]",
  muted: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// FileIcon — single public component
// ---------------------------------------------------------------------------

/**
 * Theme-aware icon component for file and folder nodes.
 *
 * Minimal theme: renders a Lucide icon with the correct size + tone token.
 * Material theme: renders the matching SVG icon. When no SVG exists for an
 *   iconName (the ~34 absent-from-asset-pack cases), falls back to the
 *   Lucide icon for that slot only (never falls back the whole theme).
 *
 * The active theme is subscribed internally (useIconThemeStore) so the
 * virtual-list parent row never re-renders on theme change — only this leaf.
 */
export function FileIcon({
  kind,
  name,
  size = "sm",
  tone,
  className,
  "aria-hidden": ariaHidden,
}: FileIconProps) {
  const theme = useIconThemeStore((s) => s.resolved);

  if (theme === "material") {
    const src = resolveMaterial(kind, name);
    if (src) {
      const px = SIZE_PX[size];
      // Material SVGs carry their own colour, so `tone` is intentionally ignored.
      // Rendered as a plain <img> with a synchronously-known src — no lazy()/
      // Suspense boundary, hence no Lucide→colour swap (flicker-free).
      return (
        <img
          src={src}
          alt=""
          aria-hidden={ariaHidden}
          width={px}
          height={px}
          className={cn(SIZE_CLASS[size], "object-contain", className)}
        />
      );
    }
    // src is null → per-icon lucide fallback (SVG absent from asset pack).
  }

  // Minimal theme path — also used as fallback when material SVG is absent.
  const LucideComp = resolveLucide(kind, name);
  return (
    <LucideComp
      aria-hidden={ariaHidden}
      className={cn(SIZE_CLASS[size], TONE_CLASS[tone], className)}
      strokeWidth={1.5}
    />
  );
}
