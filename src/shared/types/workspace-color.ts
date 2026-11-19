import { z } from "zod";

/**
 * The colors a workspace can take, in the order of the theme's lane tokens
 * (`--color-git-lane-0` … `-7`), which they are drawn from.
 */
export const WORKSPACE_COLORS = [
  "red",
  "amber",
  "lime",
  "green",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;

export type WorkspacePaletteColor = (typeof WORKSPACE_COLORS)[number];

/** "auto" leaves the color to the app, which picks one by the workspace's id. */
export const WORKSPACE_COLOR_AUTO = "auto";

export const WorkspaceColorSchema = z.enum([WORKSPACE_COLOR_AUTO, ...WORKSPACE_COLORS]);

export type WorkspaceColor = z.infer<typeof WorkspaceColorSchema>;

/** A stored or typed value as a color; "auto" for anything else, such as the old tones. */
export function toWorkspaceColor(value: unknown): WorkspaceColor {
  const parsed = WorkspaceColorSchema.safeParse(value);
  return parsed.success ? parsed.data : WORKSPACE_COLOR_AUTO;
}

/** The theme token of a color; null for "auto". */
export function workspaceColorToken(color: WorkspaceColor): string | null {
  const index = (WORKSPACE_COLORS as readonly string[]).indexOf(color);
  return index < 0 ? null : `var(--color-git-lane-${index})`;
}
