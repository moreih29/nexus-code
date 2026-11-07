import { z } from "zod";

/**
 * One release's notes, as the GitHub releases feed gives them: the body is
 * the HTML GitHub rendered from the release's Markdown, which the renderer
 * sanitizes before it shows it.
 */
export const ReleaseNoteSchema = z.object({
  /** Without the leading "v". */
  version: z.string(),
  /** What the release is about: its title after the version, or "". */
  title: z.string(),
  /** When it was published or last edited, as an ISO date. */
  date: z.string(),
  /** Its page on GitHub. */
  url: z.string(),
  html: z.string(),
  prerelease: z.boolean(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

/**
 * The recent releases on the user's channel, newest first, or why they
 * could not be read. "network" also covers a response that took too long.
 */
export const ReleaseNotesResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), notes: z.array(ReleaseNoteSchema) }),
  z.object({
    kind: z.literal("error"),
    reason: z.enum(["rate-limited", "http", "network", "unexpected"]),
  }),
]);
export type ReleaseNotesResult = z.infer<typeof ReleaseNotesResultSchema>;
