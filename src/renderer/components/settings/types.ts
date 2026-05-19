// src/renderer/components/settings/types.ts — Settings dialog shared types.

export interface SettingsNavItem {
  /** Unique identifier for this nav item — used as the activeId value. */
  id: string;
  /** Display label shown in the nav sidebar. */
  label: string;
  /** Optional group header label — items with the same group appear together. */
  group?: string;
}
