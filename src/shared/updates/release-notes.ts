import { z } from "zod";

export const ReleaseNoteSchema = z.object({
  version: z.string(),
  title: z.string(),
  date: z.string(),
  url: z.string(),
  html: z.string(),
  prerelease: z.boolean(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

export const ReleaseNotesResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), notes: z.array(ReleaseNoteSchema) }),
  z.object({
    kind: z.literal("error"),
    reason: z.enum(["rate-limited", "http", "network", "unexpected", "response-too-large"]),
  }),
]);
export type ReleaseNotesResult = z.infer<typeof ReleaseNotesResultSchema>;
