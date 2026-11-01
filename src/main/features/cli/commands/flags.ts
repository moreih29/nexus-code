/** Flags several commands share. */

export const WORKSPACE_FLAG = {
  type: "string",
  value: "WORKSPACE",
  description: "The workspace (id, id prefix or name); this terminal's by default",
} as const;

export const BACKGROUND_FLAG = {
  type: "boolean",
  description: "Open it behind the tab shown instead of showing it",
} as const;
