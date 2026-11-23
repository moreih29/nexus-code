import { z } from "zod";

const NumberSchema = z.custom<number>().check(({ value, issues }) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push({ code: "invalid_type", expected: "number", input: value });
  }
});

const IntegerSchema = NumberSchema.check(({ value, issues }) => {
  if (!Number.isInteger(value)) {
    issues.push({ code: "invalid_type", expected: "int", input: value, continue: true });
  }
});

const NonnegativeIntegerSchema = IntegerSchema.check(z.gte(0));
const NonnegativeNumberSchema = NumberSchema.check(z.gte(0));


function readableList<T extends z.ZodType>(item: T, max = Number.POSITIVE_INFINITY) {
  return z.array(z.unknown()).transform((items) => {
    const read: z.output<T>[] = [];
    for (const value of items) {
      if (read.length >= max) break;
      const one = item.safeParse(value);
      if (one.success) read.push(one.data);
    }
    return read;
  });
}

const RemoteWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),

  path: z.string(),

  parentId: z.string().optional(),

  manager: z.boolean().optional(),

  pinned: z.boolean().optional(),

  git: z
    .object({
      branch: z.string().nullable(),
      ahead: NonnegativeIntegerSchema,
      behind: NonnegativeIntegerSchema,
      uncommitted: NonnegativeIntegerSchema,
    })
    .optional(),
});

const SessionStateSchema = z.enum(["needs-you", "running", "new-result", "idle", "ended"]);

const MAX_SESSION_AGENTS = 8;

const MAX_AGENT_DESCRIPTION = 120;


const RemoteSessionAgentSchema = z.object({

  id: z.string().max(200),
  kind: z.enum(["subagent", "print"]),

  program: z.enum(["claude", "codex"]).optional(),

  type: z.string().max(60).optional(),

  description: z.string().max(MAX_AGENT_DESCRIPTION).optional(),
  state: z.enum(["running", "permissionPending", "completed", "stopped", "failed"]),

  start: NumberSchema,
});

const RemoteSessionSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  kind: z.enum(["claude", "codex", "terminal"]),
  title: z.string(),
  state: SessionStateSchema,

  failed: z.literal(true).optional(),

  since: NumberSchema.optional(),

  last: z.string().optional(),

  profile: z.string().optional(),

  cwd: z.string().optional(),

  agent: z.string().max(40).optional(),

  waiting: z
    .object({
      kind: z.enum(["permission", "question", "plan"]),
      text: z.string(),

      requestId: z.string().optional(),

      always: z.boolean().optional(),

      subagent: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),

  agents: readableList(RemoteSessionAgentSchema, MAX_SESSION_AGENTS).optional(),

  limitWait: z.object({ at: NumberSchema }).optional().catch(undefined),
});


const RemoteConsentSchema = z.object({
  id: z.string(),

  at: NumberSchema,

  expiresAt: NumberSchema,

  expiresInMs: NonnegativeIntegerSchema,

  from: z.object({

    device: z.object({ id: z.string(), name: z.string() }).optional(),

    manager: z.boolean().optional(),
    workspaceId: z.string(),

    workspaceName: z.string().optional(),
    tabId: z.string(),

    name: z.string().optional(),
  }),

  workspaceId: z.string(),

  change: z.object({
    kind: z.string(),
    detail: z.string().optional(),
    body: z.string().optional(),
    instructionEdit: z
      .object({
        layer: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("all") }),
          z.object({ kind: z.literal("agent"), agent: z.enum(["claude", "codex"]) }),
          z.object({
            kind: z.literal("profile"),
            agent: z.enum(["claude", "codex"]),
            name: z.string(),
            id: z.string(),
            showId: z.boolean().optional(),
          }),
          z.object({ kind: z.literal("workspace"), name: z.string() }),
        ]),
        clear: z.boolean(),
      })
      .optional(),
    profileAdd: z
      .object({
        agent: z.enum(["claude", "codex"]),
        folder: z.string(),
        connection: z.enum(["account", "api-key", "custom"]),
        endpoint: z.string().optional(),
      })
      .optional(),
  }),

  eachTime: z.boolean(),

  answerable: z.boolean(),
});

const RemoteRecordingSchema = z.object({
  workspaceId: z.string(),
  noteId: z.string(),

  title: z.string(),

  recordedMs: NonnegativeNumberSchema,

  at: NumberSchema,

  paused: z.boolean(),
});

const SessionsSchema = z.object({
  workspaces: z.array(RemoteWorkspaceSchema),

  sessions: readableList(RemoteSessionSchema),

  incompleteWorkspaces: z.array(z.string()).optional(),

  consents: readableList(RemoteConsentSchema).optional(),

  recording: RemoteRecordingSchema.optional(),
});


export const LegacySessionsList = SessionsSchema;
export const LegacySessionsWatch = SessionsSchema.extend({ watchId: z.string() });
