// component.ts — shadcn/Radix CSS variable adapter + SEALED constants.
//
// buildShadcnVars(tokens) replaces the old buildSemanticTokens():
//   - Takes a filled SemanticTokenSet (from a theme file)
//   - Maps SemanticKey values → shadcn --variable-name convention
//   - Appends SEALED constants that no theme can override
//
// SEALED constants are managed here (not in SemanticKey) so themes
// cannot accidentally override shadow or radius values.
//
// design.md §8 SEALED table:
//   --shadow-sm ~ --shadow-2xl  → "none"  (no-shadow elevation philosophy)
//
// design.md §4 radius 4-step (봉인 해제):
//   --radius            → "4px"   (control — default interactive element radius)
//   --radius-none       → "0px"
//   --radius-control    → "4px"
//   --radius-container  → "8px"
//   --radius-full       → "9999px"

import type { SemanticTokenSet } from "./semantic";

// ---------------------------------------------------------------------------
// SEALED — immutable constants excluded from SemanticKey.
// Declared as a const so generate-theme-css.ts can enumerate them directly.
// ---------------------------------------------------------------------------

export const SEALED: Record<string, string> = {
  // Shadow — no-shadow elevation philosophy (design.md §8)
  "--shadow-sm": "none",
  "--shadow": "none",
  "--shadow-md": "none",
  "--shadow-lg": "none",
  "--shadow-xl": "none",
  "--shadow-2xl": "none",
  // Radius — 4-step system (design.md §4, 봉인 해제)
  "--radius": "4px", // control = default
  "--radius-none": "0px",
  "--radius-control": "4px",
  "--radius-container": "8px",
  "--radius-full": "9999px",
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
    // Canvas / page background
    "--background": tokens["surface.canvas.bg"],
    "--foreground": tokens["surface.canvas.fg"],
    // Muted surfaces (sidebar, tab bar, titlebar)
    "--muted": tokens["surface.chrome.bg"],
    "--muted-foreground": tokens["surface.chrome.fg"],
    // Card surfaces
    "--card": tokens["surface.floating.bg"],
    "--card-foreground": tokens["surface.floating.fg"],
    // Popover
    "--popover": tokens["surface.floating.bg"],
    "--popover-foreground": tokens["surface.floating.fg"],
    // Primary action
    "--primary": tokens["state.selected.bg"],
    "--primary-foreground": tokens["state.selected.fg"],
    // Secondary
    "--secondary": tokens["surface.panel.bg"],
    "--secondary-foreground": tokens["surface.panel.fg"],
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
    // Border / input / ring
    "--border": tokens["surface.chrome.border"],
    "--input": tokens["surface.chrome.border"],
    "--ring": tokens["state.focus.ring"],
    // --- SEALED constants (appended before splitter/motion to match original property order) ---
    ...SEALED,
    // Splitter
    "--splitter": tokens["surface.panel.border"],
    "--splitter-hover": tokens["surface.floating.border"],
    // Motion (not in SemanticKey — invariant across themes)
    "--motion-fade": "220ms ease",
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
  };
}
