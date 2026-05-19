// component.ts — shadcn/Radix CSS variable adapter + SEALED constants.
//
// buildShadcnVars(tokens) replaces the old buildSemanticTokens():
//   - Takes a filled SemanticTokenSet (from a theme file)
//   - Maps SemanticKey values → shadcn --variable-name convention
//   - Appends SEALED constants that no theme can override
//
// SEALED constants are theme-invariant only (not density-invariant).
// Themes cannot override them, but density cascade IS allowed:
//   generate-theme-css.ts emitDensityOverrideBlock() emits
//   :root[data-density='compact'] overrides for --radius-island and
//   --island-gap using islandGeometry compact values as the authority.
//
// design.md §8 SEALED table:
//   --shadow-sm ~ --shadow-2xl  → "none"  (no-shadow elevation philosophy)
//
// design.md §4 radius 5-step Islands scale:
//   --radius            → "4px"    (control — default interactive element radius)
//   --radius-none       → "0px"
//   --radius-control    → "4px"
//   --radius-raised     → "6px"    (banners, inline cards)
//   --radius-island     → "10px"   (islands + floating surfaces; compact: 8px)
//   --radius-full       → "9999px"
//   --island-gap        → "6px"    (gap between islands; compact: 4px)

import type { SemanticTokenSet } from "./semantic";

// ---------------------------------------------------------------------------
// SEALED — theme-invariant only; excluded from SemanticKey so themes cannot
// accidentally override these values.
// Declared as a const so generate-theme-css.ts can enumerate them directly.
//
// NOTE: "theme-invariant only" does NOT mean density-invariant.
//   density override は :root[data-density] cascade で許容される.
//   SEALED の --radius-island: 10px は default (comfortable) 密度の値であり,
//   compact 密度では generate-theme-css.ts の emitDensityOverrideBlock() が
//   :root[data-density='compact'] ブロックで 8px に上書きする.
//   同様に --island-gap も compact で 4px に上書きされる.
// ---------------------------------------------------------------------------

export const SEALED: Record<string, string> = {
  // Shadow — no-shadow elevation philosophy (design.md §8)
  "--shadow-sm": "none",
  "--shadow": "none",
  "--shadow-md": "none",
  "--shadow-lg": "none",
  "--shadow-xl": "none",
  "--shadow-2xl": "none",
  // Radius — 5-step Islands scale (design.md §4)
  "--radius": "4px", // control = default interactive element radius
  "--radius-none": "0px",
  "--radius-control": "4px",
  "--radius-raised": "6px",
  // comfortable (default) density value; compact override → 8px via :root[data-density='compact']
  "--radius-island": "10px",
  "--radius-full": "9999px",
  // Island layout gap — comfortable (default) density value.
  // compact override → 4px via :root[data-density='compact'] (emitDensityOverrideBlock).
  "--island-gap": "6px",
} as const;

// ---------------------------------------------------------------------------
// buildShadcnVars — assembles the final CSS custom-property map.
//
// Mapping strategy: shadcn variable names are intentionally kept as-is for
// backward compatibility with existing component consumers. The SemanticKey
// values from the theme fill the color slots; SEALED values are appended
// and cannot be overridden by the theme.
//
// Returns: Record<string, string> — CSS variable name → value
// ---------------------------------------------------------------------------

export function buildShadcnVars(tokens: SemanticTokenSet): Record<string, string> {
  return {
    // --- shadcn color tier (mapped from SemanticKey) ---
    // Page background = island surface (the editor canvas is the primary island)
    "--background": tokens["surface.island.bg"],
    "--foreground": tokens["surface.island.fg"],
    // Muted surface = backdrop frame (titlebar, status bar, island gaps)
    "--muted": tokens["surface.backdrop.bg"],
    "--muted-foreground": tokens["surface.backdrop.fg"],
    // Card surfaces
    "--card": tokens["surface.floating.bg"],
    "--card-foreground": tokens["surface.floating.fg"],
    // Popover
    "--popover": tokens["surface.floating.bg"],
    "--popover-foreground": tokens["surface.floating.fg"],
    // Primary action
    "--primary": tokens["state.selected.bg"],
    "--primary-foreground": tokens["state.selected.fg"],
    // Secondary = island surface (panels are islands)
    "--secondary": tokens["surface.island.bg"],
    "--secondary-foreground": tokens["surface.island.fg"],
    // Accent
    "--accent": tokens["state.focus.ring"],
    "--accent-foreground": tokens["state.selected.bg"],
    // Destructive / Error state
    "--destructive": tokens["state.error.fg"],
    "--destructive-foreground": tokens["surface.floating.fg"],
    "--state-error-fg": tokens["state.error.fg"],
    "--state-error-border": tokens["state.error.border"],
    "--state-error-bg": tokens["state.error.bg"],
    // Warning state (e.g. Caps Lock hint on the SSH password field)
    "--state-warning-fg": tokens["state.warning.fg"],
    // Border / input / ring — island internal hairline
    "--border": tokens["surface.island.border"],
    "--input": tokens["surface.island.border"],
    "--ring": tokens["state.focus.ring"],
    // --- SEALED constants (appended before splitter/motion to match original property order) ---
    ...SEALED,
    // Splitter — island internal hairline
    "--splitter-hover": tokens["surface.floating.border"],
    // Motion (not in SemanticKey — invariant across themes, design.md §7)
    "--motion-fade": "220ms ease",
    // Scale entry for popovers/dialogs — kept inside the 150~220ms band.
    "--motion-scale": "160ms ease",
    // Floating surface scrim — modal backdrop for L3 dialogs/command palette.
    // Uses surface.floating.scrim so the backdrop is theme-switched correctly.
    "--floating-scrim": tokens["surface.floating.scrim"],
    // State overlays — exposed so components can reference via var() without
    // hardcoding rgba literals that break on the light theme (design.md §7).
    "--state-hover-bg": tokens["state.hover.bg"],
    "--state-active-bg": tokens["state.active.bg"],
    "--state-selected-bg": tokens["state.selected.bg"],
    "--state-selected-indicator": tokens["state.selected.indicator"],
    "--state-loading-indicator": tokens["state.loading.indicator"],
    // Sidebar-region selected background — sidebar.item.selected.bg is scoped to the
    // sidebar surface level and differs from state.selected.bg (design.md §9).
    // The indicator color uses the shared --state-selected-indicator token (C-1 unification).
    "--sidebar-item-selected-bg": tokens["sidebar.item.selected.bg"],
    // Tab surface tokens — exposed so tab-bar components use semantic values
    // rather than static frosted-veil primitives (design.md §9 tab region).
    "--tab-active-bg": tokens["tab.active.bg"],
    "--tab-active-border": tokens["tab.active.border"],
    "--tab-hover-bg": tokens["tab.hover.bg"],
    "--tab-modified-dot": tokens["tab.modified.dot"],
    // Editor text tokens — exposed for components that display code-adjacent metadata
    // (paths, remote addresses) and must match the editor surface text scale.
    "--editor-text-muted": tokens["editor.text.muted"],
    // Status bar tokens — L1 chrome bar region (design.md §9 status bar region).
    "--status-bar-bg": tokens["status.bar.bg"],
    "--status-bar-fg": tokens["status.bar.fg"],
    "--status-bar-item-hover-bg": tokens["status.bar.item.hover.bg"],
    "--status-bar-error-bg": tokens["status.bar.error.bg"],
    "--status-bar-error-fg": tokens["status.bar.error.fg"],
    "--status-bar-warning-bg": tokens["status.bar.warning.bg"],
    "--status-bar-warning-fg": tokens["status.bar.warning.fg"],
    // Islands surfaces — backdrop frame + island surface + inactive veil (design.md §2/§5)
    "--surface-backdrop-bg": tokens["surface.backdrop.bg"],
    "--surface-backdrop-fg": tokens["surface.backdrop.fg"],
    "--surface-island-bg": tokens["surface.island.bg"],
    "--surface-island-fg": tokens["surface.island.fg"],
    "--surface-island-border": tokens["surface.island.border"],
    "--surface-island-inactive-veil": tokens["surface.island.inactive.veil"],
    // Floating outer border — the Floating layer (dialogs/menus/popovers) may
    // carry an outline, unlike islands (design.md §2). Exposed under a properly
    // named var so dialogs stop borrowing the misnamed --splitter-hover alias.
    "--surface-floating-border": tokens["surface.floating.border"],
    // Drag-and-drop — insertion indicator + valid drop target (design.md §8)
    "--state-drag-indicator": tokens["state.drag.indicator"],
    "--state-drop-target-bg": tokens["state.drop.target.bg"],
    // Scrollbar — thumb / track (design.md §10)
    "--scrollbar-thumb-bg": tokens["scrollbar.thumb.bg"],
    "--scrollbar-thumb-hover-bg": tokens["scrollbar.thumb.hover.bg"],
    "--scrollbar-track-bg": tokens["scrollbar.track.bg"],
  };
}
