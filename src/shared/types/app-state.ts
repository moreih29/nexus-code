import { z } from "zod";
import {
  IntegerSchema,
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { AgentProfilesSchema } from "../agent-profiles/profiles";
import {
  AgentInstructionsSchema,
  ChatInstructionHistorySchema,
  ClaudeInstructionDigestsSchema,
} from "../chat/instructions";
import {
  LIMIT_RESUME_BOUNDS,
  LIMIT_RESUME_DEFAULTS,
  LIMIT_RESUME_MESSAGE_LINE,
} from "../chat/limit-resume-settings";
import { THEME_SOURCES } from "../design-tokens";
import { KeybindingOverridesSchema } from "../keybindings/overrides";
import { LSP_MAX_ACTIVE_WORKSPACES_LIMIT, LspLanguageSettingsSchema } from "../lsp/settings";
import {
  DEFAULT_RECORDING_SUMMARY_SETTINGS,
  RecordingSummarySettingsSchema,
} from "../notes/summary";
import { VoiceNameSettingsSchema } from "../notes/voice-names";
import { CustomShellSchema, ShellChoiceSchema } from "../pty/shell";
import { AgentViewSnapshotSchema } from "./agent-view";
import { WorkspaceLayoutSnapshotSchema } from "./layout";

const themeIds = THEME_SOURCES.map((s) => s.id) as [string, ...string[]];
export const ThemePreferenceSchema = z.enum(themeIds);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const RemoteAgentsPolicySchema = z.enum(["ask", "allow", "deny"]);
export type RemoteAgentsPolicy = z.infer<typeof RemoteAgentsPolicySchema>;

export const PhonePushPolicySchema = z.enum(["away", "always", "off"]);
export type PhonePushPolicy = z.infer<typeof PhonePushPolicySchema>;

export const WindowBoundsSchema = z.object({
  x: NumberSchema,
  y: NumberSchema,
  width: NumberSchema,
  height: NumberSchema,
});

export const WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX = 100;

export const AppStateSchema = z.object({
  windowBounds: WindowBoundsSchema.optional(),
  lastActiveWorkspaceId: z.string().optional(),
  sidebarWidth: PositiveIntegerSchema.optional(),
  workspaceSidebarFoldedPeers: z
    .array(z.string().min(1).max(64))
    .max(WORKSPACE_SIDEBAR_FOLDED_PEERS_MAX)
    .optional(),
  filesPanelWidth: PositiveIntegerSchema.optional(),
  noteTranscriptWidth: PositiveIntegerSchema.optional(),
  noteTranscriptShare: NumberSchema.check(z.gt(0)).check(z.lt(1)).optional(),
  noteSummary: RecordingSummarySettingsSchema.catch(DEFAULT_RECORDING_SUMMARY_SETTINGS),
  sidebarHidden: z.boolean().optional(),
  filesPanelHidden: z.boolean().optional(),
  filesPanelModeByWorkspace: z.record(z.guid(), z.string().max(16)).optional(),
  agentListFoldedGroups: z.array(z.string()).optional(),
  agentListUnfoldedTasks: z.array(z.string()).optional(),
  layoutByWorkspace: z.record(z.guid(), WorkspaceLayoutSnapshotSchema).optional(),
  lspEnabled: z.boolean().optional(),
  lspLanguages: z.record(z.string(), LspLanguageSettingsSchema).optional(),
  lspMaxActiveWorkspaces: IntegerSchema.check(z.gte(1))
    .check(z.lte(LSP_MAX_ACTIVE_WORKSPACES_LIMIT))
    .optional(),
  lspDisabledLanguagesByWorkspace: z.record(z.guid(), z.array(z.string())).optional(),
  themePreference: ThemePreferenceSchema.optional(),
  windowOpacity: NumberSchema.check(z.gte(0)).check(z.lte(1)).optional(),

  inactivePanelDim: NumberSchema.check(z.gte(0)).check(z.lte(2)).optional(),

  density: z.enum(["default", "compact"]).optional(),

  editorFontSize: IntegerSchema.check(z.gte(8)).check(z.lte(32)).optional(),

  editorFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  editorFontLigatures: z.boolean().optional(),

  editorFontLineHeight: z.union([z.literal(1.0), z.literal(1.2), z.literal(1.4)]).optional(),

  terminalFontSize: IntegerSchema.check(z.gte(8)).check(z.lte(32)).optional(),

  terminalCursorStyle: z.enum(["block", "underline", "bar"]).optional(),

  terminalFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  terminalFontLigatures: z.boolean().optional(),

  chatFontSize: IntegerSchema.check(z.gte(10)).check(z.lte(24)).optional(),

  chatFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"-]+$/)
    .optional(),

  terminalShell: ShellChoiceSchema.optional(),

  terminalShells: z.array(CustomShellSchema).max(64).optional(),

  agentProfiles: AgentProfilesSchema.optional(),
  agentInstructions: AgentInstructionsSchema.optional(),
  chatInstructionHistory: ChatInstructionHistorySchema.optional(),
  claudeInstructionDigests: ClaudeInstructionDigestsSchema.optional(),
  attachCleanups: z
    .array(z.object({ host: z.string().max(512), workspaceId: z.string().max(64) }))
    .max(200)
    .optional()
    .catch(undefined),

  taskAgent: z.string().max(32).optional(),

  taskAgentCommand: z.string().max(1024).optional(),

  agentListViewDefault: z.string().max(32).optional(),

  agentListViewByWorkspace: z.record(z.guid(), z.string().max(32)).optional(),

  agentView: AgentViewSnapshotSchema.optional(),

  portForwardsByWorkspace: z
    .record(
      z.guid(),
      z
        .array(
          z.object({
            remotePort: PositiveIntegerSchema,
            localPort: PositiveIntegerSchema,
          }),
        )
        .max(256),
    )
    .optional(),

  previewViewDefaults: z.record(z.string().max(32), z.enum(["raw", "preview"])).optional(),

  updateChannel: z.enum(["stable", "beta"]).default("stable"),

  ignoredUpdateVersion: z.string().nullable().default(null),

  announcedUpdateVersion: z.string().max(64).nullable().default(null),

  lastSeenReleaseNotesVersion: z.string().max(64).nullable().default(null),

  autoCheckForUpdates: z.boolean().default(true),

  osNotificationsEnabled: z.boolean().default(true),

  rateLimitWarnings: z.boolean().default(true),

  chatLimitResume: z.boolean().default(true),
  chatLimitResumeDelayMinutes: z
    .int()
    .min(LIMIT_RESUME_BOUNDS.chatLimitResumeDelayMinutes.min)
    .max(LIMIT_RESUME_BOUNDS.chatLimitResumeDelayMinutes.max)
    .default(LIMIT_RESUME_DEFAULTS.chatLimitResumeDelayMinutes),
  chatLimitResumeMaxTries: z
    .int()
    .min(LIMIT_RESUME_BOUNDS.chatLimitResumeMaxTries.min)
    .max(LIMIT_RESUME_BOUNDS.chatLimitResumeMaxTries.max)
    .default(LIMIT_RESUME_DEFAULTS.chatLimitResumeMaxTries),
  chatLimitResumeDeadlineHours: z
    .int()
    .min(LIMIT_RESUME_BOUNDS.chatLimitResumeDeadlineHours.min)
    .max(LIMIT_RESUME_BOUNDS.chatLimitResumeDeadlineHours.max)
    .default(LIMIT_RESUME_DEFAULTS.chatLimitResumeDeadlineHours),
  chatLimitResumeMessage: z
    .string()
    .regex(LIMIT_RESUME_MESSAGE_LINE)
    .default(LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage),

  voiceLanguage: z.enum(["app", "multi"]).default("app"),

  voiceSendNames: z.boolean().default(false),

  rememberedVoices: VoiceNameSettingsSchema.optional(),

  keychainSignature: z.string().max(128).nullable().default(null),

  remoteControl: z.boolean().default(false),

  remoteTerminalControl: z.boolean().default(false),

  remoteAgents: RemoteAgentsPolicySchema.default("ask"),
  phonePush: PhonePushPolicySchema.default("away"),

  cliEnabled: z.boolean().default(true),

  cliCrossWorkspace: z.enum(["ask", "allow", "deny"]).default("ask"),

  cliAgentContext: z.boolean().default(true),

  browserPermissionGrants: z.record(z.string(), z.boolean()).optional(),

  language: z.enum(["ko", "en"]).optional(),

  iconTheme: z.enum(["minimal", "material"]).optional(),

  keybindingOverrides: KeybindingOverridesSchema.optional(),

  editorKeybindingOverrides: KeybindingOverridesSchema.optional(),
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
