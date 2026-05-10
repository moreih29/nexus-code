import { z } from "zod";

export const PanelKindSchema = z.enum(["search", "git"]);
export type PanelKind = z.infer<typeof PanelKindSchema>;

export const ViewModeSchema = z.enum(["list", "tree"]);
export type ViewMode = z.infer<typeof ViewModeSchema>;

export const PanelViewOptionsSchema = z.object({
  viewMode: ViewModeSchema,
  compactFolders: z.boolean(),
});
export type PanelViewOptions = z.infer<typeof PanelViewOptionsSchema>;

export const PanelGetViewOptionsArgsSchema = z.object({
  workspaceId: z.string(),
  panelKind: PanelKindSchema,
});
export type PanelGetViewOptionsArgs = z.infer<typeof PanelGetViewOptionsArgsSchema>;

export const PanelSetViewOptionsArgsSchema = z.object({
  workspaceId: z.string(),
  panelKind: PanelKindSchema,
  viewMode: ViewModeSchema.optional(),
  compactFolders: z.boolean().optional(),
});
export type PanelSetViewOptionsArgs = z.infer<typeof PanelSetViewOptionsArgsSchema>;

export const DEFAULT_VIEW_OPTIONS_BY_PANEL: Record<PanelKind, PanelViewOptions> = {
  search: { viewMode: "list", compactFolders: false },
  git: { viewMode: "tree", compactFolders: false },
};
