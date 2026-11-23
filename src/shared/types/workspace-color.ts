import { z } from "zod";

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

export const WORKSPACE_COLOR_AUTO = "auto";

export const WorkspaceColorSchema = z.enum([WORKSPACE_COLOR_AUTO, ...WORKSPACE_COLORS]);

export type WorkspaceColor = z.infer<typeof WorkspaceColorSchema>;

export function toWorkspaceColor(value: unknown): WorkspaceColor {
  const parsed = WorkspaceColorSchema.safeParse(value);
  return parsed.success ? parsed.data : WORKSPACE_COLOR_AUTO;
}

export function workspaceColorToken(color: WorkspaceColor): string | null {
  const index = (WORKSPACE_COLORS as readonly string[]).indexOf(color);
  return index < 0 ? null : `var(--color-git-lane-${index})`;
}
