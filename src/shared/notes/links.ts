import { z } from "zod";
import { WorkspaceIdSchema } from "../types/workspace-id";

export const MAX_NOTE_LINKS = 200;
export const MAX_NOTE_LINK_BYTES = 256 * 1024;
export const MAX_LINK_TITLE = 200;
export const MAX_EARLIER_SESSIONS = 5;
export const MAX_REPORT_CHARS = 500;

export const NoteLinkIdSchema = z.string().regex(/^l[a-z0-9]{7,39}$/);
const sessionId = z.string().min(1).max(256);
const timestamp = z.number().nonnegative();
const linkAgent = z.enum(["claude", "codex"]);

export const NoteLinkTargetSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  tabId: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096),
  profileId: z.string().min(1).max(256).optional(),
  session: sessionId.optional(),
  title: z.string().max(MAX_LINK_TITLE),
});

export const NoteReportPrSchema = z.object({
  number: z.number().int().positive().optional(),
  url: z.url({ protocol: /^https?$/ }).max(8192),
});

export const NoteLinkResultSchema = z.object({
  state: z.enum(["done", "failed"]),
  summary: z
    .string()
    .refine((s) => Array.from(s).length <= MAX_REPORT_CHARS)
    .optional(),
  pr: NoteReportPrSchema.optional(),
  at: timestamp,
});

export const NewNoteLinkSchema = NoteLinkTargetSchema.extend({
  agent: linkAgent,
  kind: z.enum(["note", "line", "task", "mention", "selection", "card"]),
  task: z
    .object({ workspaceId: WorkspaceIdSchema, branch: z.string().min(1).max(1024) })
    .optional(),
  messageId: z.string().min(1).max(256).optional(),
  result: NoteLinkResultSchema.optional(),
});

export const NoteLinkSchema = NewNoteLinkSchema.extend({
  sessions: z.array(sessionId).max(MAX_EARLIER_SESSIONS).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const NoteLinkPatchSchema = NoteLinkTargetSchema.partial().extend({
  profileId: NoteLinkTargetSchema.shape.profileId.nullable(),
});

export const NoteLinkEntrySchema = z.object({ id: NoteLinkIdSchema, link: NoteLinkSchema });
export const NoteConversationSchema = NoteLinkTargetSchema.pick({
  workspaceId: true,
  tabId: true,
  session: true,
}).extend({ agent: linkAgent });

export type NewNoteLink = z.infer<typeof NewNoteLinkSchema>;
export type NoteLink = z.infer<typeof NoteLinkSchema>;
export type NoteLinkTarget = z.infer<typeof NoteLinkTargetSchema>;
export type NoteLinkPatch = z.infer<typeof NoteLinkPatchSchema>;
export type NoteLinkEntry = z.infer<typeof NoteLinkEntrySchema>;
export type NoteConversation = z.infer<typeof NoteConversationSchema>;

export type NoteLinkResult = z.infer<typeof NoteLinkResultSchema>;
