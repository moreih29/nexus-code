/**
 * Theme-aware unified icon component for file and folder nodes.
 *
 * Architecture:
 *   - `resolveLucide` and `resolveMaterialIconName` live in file-icon-resolvers.ts
 *     as pure functions (no Vite-specific imports) so they can be unit-tested in Bun.
 *   - `resolveMaterial(kind, name)` below wraps the iconName resolver with the
 *     Vite-specific SVG static-import map and import.meta.glob lazy loader.
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

import { type ComponentType, lazy, Suspense, type SVGProps } from "react";
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
// Static imports for the 12 highest-frequency material icons.
// These ship in the initial bundle so they appear on the first paint without
// a dynamic import round-trip (decode-flash prevention for the common case).
// ---------------------------------------------------------------------------

import CssSvg from "@/assets/icons/material/css.svg?react";
import FileSvg from "@/assets/icons/material/file.svg?react";
import FolderSvg from "@/assets/icons/material/folder.svg?react";
import FolderOpenSvg from "@/assets/icons/material/folder-open.svg?react";
import HtmlSvg from "@/assets/icons/material/html.svg?react";
import JavascriptSvg from "@/assets/icons/material/javascript.svg?react";
import JsonSvg from "@/assets/icons/material/json.svg?react";
import MarkdownSvg from "@/assets/icons/material/markdown.svg?react";
import PythonSvg from "@/assets/icons/material/python.svg?react";
import ReactSvg from "@/assets/icons/material/react.svg?react";
import ReactTsSvg from "@/assets/icons/material/react_ts.svg?react";
import TypescriptSvg from "@/assets/icons/material/typescript.svg?react";

/** Static map: iconName → eagerly-bundled SVG React component. */
const MATERIAL_STATIC: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  typescript: TypescriptSvg,
  react_ts: ReactTsSvg,
  javascript: JavascriptSvg,
  react: ReactSvg,
  json: JsonSvg,
  markdown: MarkdownSvg,
  python: PythonSvg,
  css: CssSvg,
  html: HtmlSvg,
  folder: FolderSvg,
  "folder-open": FolderOpenSvg,
  file: FileSvg,
};

// ---------------------------------------------------------------------------
// Lazy glob for all remaining material SVGs.
// Keys are module paths like "@/assets/icons/material/rust.svg?react".
// ---------------------------------------------------------------------------

// NOTE: the `?react` SVG transform MUST be passed via the `query` option, not
// embedded in the glob pattern string. Vite treats a `*.svg?react` pattern
// literally and matches zero files, which would silently fall every non-static
// icon back to Lucide. With `query: "?react"` the glob matches all SVGs and
// each module's default export is the svgr React component.
const MATERIAL_LAZY_GLOB = import.meta.glob<{ default: ComponentType<SVGProps<SVGSVGElement>> }>(
  "@/assets/icons/material/*.svg",
  { query: "?react", eager: false },
);

/** iconName → lazy loader, derived from the glob result at module init time. */
const MATERIAL_LAZY: Record<
  string,
  () => Promise<{ default: ComponentType<SVGProps<SVGSVGElement>> }>
> = {};
for (const [path, loader] of Object.entries(MATERIAL_LAZY_GLOB)) {
  // Keys end with "…/<name>.svg" (query is not part of the glob key).
  const match = path.match(/\/([^/]+)\.svg(?:\?.*)?$/);
  if (match) {
    MATERIAL_LAZY[match[1]] = loader;
  }
}

/** Cache of lazy-wrapped components — avoids recreating lazy() on every render. */
const LAZY_COMPONENT_CACHE: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {};

/**
 * Resolves the material SVG component for a given node kind and name.
 *
 * Returns the React component if an SVG asset exists (static or lazy),
 * or null when the iconName from the manifest has no corresponding SVG file
 * (covers the ~34 manifest entries that are absent from the asset pack).
 *
 * Not a hook — no store access, no React state. The name "resolve" is
 * consistent with the pattern in file-icon-resolvers.ts.
 */
function resolveMaterial(
  kind: FileIconKind,
  name?: string,
): ComponentType<SVGProps<SVGSVGElement>> | null {
  const iconName = resolveMaterialIconName(kind, name);
  if (!iconName) return null;

  // 1. Static map: highest-frequency icons — no async round-trip.
  if (iconName in MATERIAL_STATIC) return MATERIAL_STATIC[iconName];

  // 2. Lazy map: iconName must appear in the glob result (SVG file exists).
  if (!(iconName in MATERIAL_LAZY)) return null;

  // 3. Memoize the lazy() wrapper per iconName.
  if (!(iconName in LAZY_COMPONENT_CACHE)) {
    const loader = MATERIAL_LAZY[iconName];
    LAZY_COMPONENT_CACHE[iconName] = lazy(loader);
  }
  return LAZY_COMPONENT_CACHE[iconName];
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
    const MaterialComp = resolveMaterial(kind, name);
    if (MaterialComp) {
      const px = SIZE_PX[size];
      // Material SVGs carry their own colour — we omit tone classes on purpose.
      // Suspense fallback shows the lucide icon while the lazy chunk loads.
      const LucideComp = resolveLucide(kind, name);
      const lucideFallback = (
        <LucideComp
          aria-hidden={ariaHidden}
          className={cn(SIZE_CLASS[size], TONE_CLASS[tone], className)}
          strokeWidth={1.5}
        />
      );
      return (
        <Suspense fallback={lucideFallback}>
          <MaterialComp
            aria-hidden={ariaHidden}
            width={px}
            height={px}
            className={cn(SIZE_CLASS[size], "object-contain", className)}
          />
        </Suspense>
      );
    }
    // MaterialComp is null → per-icon lucide fallback (SVG absent from asset pack).
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
