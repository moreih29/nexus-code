// src/renderer/components/settings/types.ts — Settings dialog shared types.

export interface SettingsNavItem {
  /** Unique identifier for this nav item — used as the activeId value. */
  id: string;
  /** Display label shown in the nav sidebar. */
  label: string;
  /** Optional group header label — items with the same group appear together. */
  group?: string;
  /**
   * Tokens used by the search box to match this item beyond `label`.
   * E.g. an "Appearance" item might add ["theme", "opacity"] so typing "opa"
   * still surfaces it.
   */
  keywords?: string[];
  /**
   * When true, the nav row shows a small dot indicating the panel has
   * uncommitted / changed-from-default values in the current session.
   * Caller is responsible for computing this per-panel.
   */
  dirty?: boolean;
}
