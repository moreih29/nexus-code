import { z } from "zod";
import { AgentProfilesSchema } from "../agent-profiles/profiles";
import { THEME_SOURCES } from "../design-tokens";
import { KeybindingOverridesSchema } from "../keybindings/overrides";
import { LSP_MAX_ACTIVE_WORKSPACES_LIMIT, LspLanguageSettingsSchema } from "../lsp/settings";
import { CustomShellSchema, ShellChoiceSchema } from "../pty/shell";
import { AgentViewSnapshotSchema } from "./agent-view";
import { WorkspaceLayoutSnapshotSchema } from "./layout";

// ThemePreferenceSchema mirrors the registered ThemeId set. The "system"
// preference was retired when external themes replaced the first-party
// warm/cool pair (only one light variant ships, so OS Auto can't pick a
// matching dark partner deterministically).
// design.md §8 decision: "ThemeId를 shared 단일소스로 참조 — zod enum 이중정의 금지"
const themeIds = THEME_SOURCES.map((s) => s.id) as [string, ...string[]];
export const ThemePreferenceSchema = z.enum(themeIds);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const AppStateSchema = z.object({
  windowBounds: WindowBoundsSchema.optional(),
  lastActiveWorkspaceId: z.string().optional(),
  sidebarWidth: z.number().int().positive().optional(),
  filesPanelWidth: z.number().int().positive().optional(),
  // Sidebar (workspace switcher strip) hidden state. Persisted so a
  // restart preserves the layout the user last chose. Absent = visible.
  sidebarHidden: z.boolean().optional(),
  // Files panel (tree/git/search column) hidden state. Persisted
  // independently of `sidebarHidden`; both toggle together only via the
  // ⌘⇧B command, never via storage coupling.
  filesPanelHidden: z.boolean().optional(),
  // The agents tab's list, as a share of the tab's width, as its divider
  // was last dragged. Absent or null = the default, min(480px, 50%).
  sessionsListRatio: z.number().min(0).max(1).nullable().optional(),
  layoutByWorkspace: z.record(z.string().uuid(), WorkspaceLayoutSnapshotSchema).optional(),
  // Experimental: whether language servers run at all. Absent = off.
  // Settings › Editor applies a change at once; see shared/lsp/settings.ts
  // for how the lsp* fields combine.
  lspEnabled: z.boolean().optional(),
  // Each language's own settings, keyed by preset language id. A language
  // left out runs while lspEnabled is on.
  lspLanguages: z.record(z.string(), LspLanguageSettingsSchema).optional(),
  // How many workspaces keep their servers running; absent = 4.
  lspMaxActiveWorkspaces: z.number().int().min(1).max(LSP_MAX_ACTIVE_WORKSPACES_LIMIT).optional(),
  // Per workspace, the languages turned off in it. Key = workspaceId (UUID).
  lspDisabledLanguagesByWorkspace: z.record(z.string().uuid(), z.array(z.string())).optional(),
  // Theme preference persisted to appState (authoritative store).
  // localStorage is also written as a boot cache for FOUC prevention.
  themePreference: ThemePreferenceSchema.optional(),
  // Window opacity (0–1). 1 = fully opaque (default, omitted from storage).
  // Mirrors Ghostty's background-opacity semantics.
  // Applies live on macOS and Windows 11 22H2+. A Linux window opens transparent
  // only while this is under 1, so crossing 1 there applies at the next launch —
  // `transparent` is constructor-only in Electron.
  windowOpacity: z.number().min(0).max(1).optional(),

  // Inactive-panel dim multiplier — scales each theme's tuned inactive-veil
  // alpha. 1 = theme default (omitted from storage), 0 = no dim, 2 = double.
  // Applied at runtime via --inactive-panel-dim CSS var; no restart needed.
  inactivePanelDim: z.number().min(0).max(2).optional(),

  // UI density — 닫힌 집합; 부재=토큰 fallback ('default').
  density: z.enum(["default", "compact"]).optional(),

  // Editor font size in px — integer, clamped to [8, 32]; 부재=토큰 fallback (16).
  // Widened from a closed set so the Settings dialog can offer a numeric
  // stepper instead of a discrete slider (user-driven UX change).
  editorFontSize: z.number().int().min(8).max(32).optional(),

  // Editor font family — sanitize: CSS injection 차단 (/^[A-Za-z0-9\s,'"]+$/); 부재=토큰 fallback.
  editorFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  // Editor font ligatures toggle — 부재=토큰 fallback (false).
  editorFontLigatures: z.boolean().optional(),

  // Editor line height — 닫힌 집합; 부재=토큰 fallback (1.4).
  editorFontLineHeight: z.union([z.literal(1.0), z.literal(1.2), z.literal(1.4)]).optional(),

  // Terminal font size in px — integer, clamped to [8, 32]; 부재=토큰 fallback (14).
  // Widened from a closed set so the Settings dialog can offer a numeric
  // stepper instead of a discrete slider.
  terminalFontSize: z.number().int().min(8).max(32).optional(),

  // Terminal cursor style — 닫힌 집합; 부재=토큰 fallback ('block').
  terminalCursorStyle: z.enum(["block", "underline", "bar"]).optional(),

  // Terminal font family — editor와 독립. sanitize: CSS injection 차단
  // (/^[A-Za-z0-9\s,'"]+$/); 부재=토큰 fallback (monoDisplay).
  terminalFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  // Terminal font ligatures toggle — editor와 독립; 부재=토큰 fallback (false).
  terminalFontLigatures: z.boolean().optional(),

  // The chat tabs' (Claude, Codex) text size in px: their replies' size, which
  // the rest of a tab's text scales with. Absent = 14.
  chatFontSize: z.number().int().min(10).max(24).optional(),

  // The chat tabs' font, as CSS names it; absent = the app's. Sanitized as
  // the editor's, with a hyphen allowed for names such as system-ui.
  chatFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"-]+$/)
    .optional(),

  // The shell new local terminals open with; absent = the system default
  // (Windows PowerShell on Windows, $SHELL elsewhere).
  terminalShell: ShellChoiceSchema.optional(),

  // Shells the user added in Settings › Terminal, besides the detected ones.
  terminalShells: z.array(CustomShellSchema).max(64).optional(),

  // Claude and Codex profiles (config folders, each with its own sign-in),
  // and the rules that pick a workspace's. Absent = each agent's default
  // folder everywhere.
  agentProfiles: AgentProfilesSchema.optional(),

  // What a new task opens with (a TaskAgent): a Claude or Codex tab given the
  // task's first prompt, or a plain terminal; absent = "claude". Kept as a
  // plain string so an agent this version lacks does not fail the state.
  taskAgent: z.string().max(32).optional(),

  // The command earlier versions ran in a new task's terminal; read once to
  // carry the choice over to `taskAgent`, then dropped.
  taskAgentCommand: z.string().max(1024).optional(),

  // The view a sessions tab opens in (a SessionsView); absent = "status". Kept
  // as a plain string so a view this version lacks does not fail the state.
  sessionsViewDefault: z.string().max(32).optional(),

  // The view each workspace's sessions tab was last switched to, by the
  // workspace its tasks belong to; it outlasts a change of the default.
  sessionsViewByWorkspace: z.record(z.string().uuid(), z.string().max(32)).optional(),

  // The agent view: whether the window shows it rather than the workspaces,
  // and its panels, each holding agents by session key. Absent = the
  // workspaces, and one empty panel.
  agentView: AgentViewSnapshotSchema.optional(),

  // The ports each SSH workspace forwards to this machine, and where each
  // listens here, so a browser tab left on a forward's local port finds it
  // again after a restart.
  portForwardsByWorkspace: z
    .record(
      z.string().uuid(),
      z
        .array(
          z.object({
            remotePort: z.number().int().positive(),
            localPort: z.number().int().positive(),
          }),
        )
        .max(256),
    )
    .optional(),

  // The view a file with a preview opens in, by its format ("markdown",
  // "json", …); a format left out opens as it does by default. Keyed by a
  // plain string so a format this version lacks does not fail the state.
  previewViewDefaults: z.record(z.string().max(32), z.enum(["raw", "preview"])).optional(),

  // Update channel — "stable" follows non-prerelease tags only; "beta" also
  // includes prerelease tags (e.g. v1.2.0-beta.1).  Defaults to "stable".
  updateChannel: z.enum(["stable", "beta"]).default("stable"),

  // Version string that the user chose to ignore.  When the poller finds this
  // version as the latest, the statusChanged event is suppressed silently.
  // Reset to null when the user changes updateChannel.
  ignoredUpdateVersion: z.string().nullable().default(null),

  // The newer version the user was last told of with a toast. A check by
  // the app itself toasts a version once; after that only the title bar's
  // update button shows it, however many hours the app keeps checking.
  announcedUpdateVersion: z.string().max(64).nullable().default(null),

  // The app version whose release notes the user has seen, or was taken to
  // have: the first launch that finds it absent sets it to the running
  // version without a word. While an update leaves it behind, the title bar
  // offers that version's notes.
  lastSeenReleaseNotesVersion: z.string().max(64).nullable().default(null),

  // Auto-check toggle. When true (default), the updates domain polls GH
  // Releases silently once the app starts and every few hours while it
  // runs, and the title bar shows a newer version. When false, the
  // auto-polls are skipped; the user can still trigger a manual check from
  // the About panel or the App menu — manual triggers always respond
  // regardless of this setting.
  autoCheckForUpdates: z.boolean().default(true),

  // OS-level desktop notifications master toggle. When true (default), the
  // claude hook handler fires Electron `Notification`s on Notification /
  // PermissionRequest / Stop hooks while the user is not viewing the active
  // tab. When false, all three pathways are suppressed at the single
  // `fireOsNotification` gate. The in-app status broker (sidebar indicator
  // glyphs, attention badges) is unaffected — only OS-level notifications.
  osNotificationsEnabled: z.boolean().default(true),

  // Whether a Claude tab warns, above its composer, that the account's usage
  // limit is near. Off hides the warning only: a limit reached still shows.
  rateLimitWarnings: z.boolean().default(true),

  // The nexus command in the app's terminals (main/features/cli). Off, every
  // nexus command fails with a note saying so.
  cliEnabled: z.boolean().default(true),

  // What nexus may do to a workspace other than its terminal's own: ask the
  // user each time, allow it, or refuse it. Reading is always allowed.
  cliCrossWorkspace: z.enum(["ask", "allow", "deny"]).default("ask"),

  // Whether Claude Code sessions started in the app are told about nexus at
  // their start (a SessionStart hook prints a short note).
  cliAgentContext: z.boolean().default(true),

  // The agent manager (shared/manager): a Claude Code or Codex session the
  // app starts with itself, which follows and directs every workspace's
  // agent sessions through nexus.
  managerEnabled: z.boolean().default(false),
  managerAgent: z.enum(["claude", "codex"]).default("claude"),
  // The profile each agent runs it with; absent = the agent's default profile.
  managerProfiles: z
    .object({
      claude: z.string().min(1).max(64).optional(),
      codex: z.string().min(1).max(64).optional(),
    })
    .optional(),
  // Which session changes the app tells it (shared/manager MANAGER_NOTIFY).
  managerNotify: z.enum(["tasks", "attention", "all"]).default("attention"),
  // What it may do with another session's permission request.
  managerPermissions: z.enum(["user", "ask", "answer"]).default("user"),
  // Its reports as desktop notifications too, while the user is not looking.
  managerReports: z.boolean().default(true),
  // The session (Claude) or thread (Codex) it goes on with when the app
  // starts, and the profile whose folder has it.
  managerSession: z
    .object({
      agent: z.enum(["claude", "codex"]),
      id: z.string().max(128),
      profileId: z.string().min(1).max(64).optional(),
    })
    .optional(),

  // Global browser permission toggles keyed by BrowserPermissionKind string.
  // Absent key (or absent field) means the permission is OFF (denied).
  // z.record key is z.string() for runtime compatibility; callers narrow the
  // key type to BrowserPermissionKind at usage sites.
  browserPermissionGrants: z.record(z.string(), z.boolean()).optional(),

  // UI language override. Absent = follow OS locale (auto-detect).
  // Mirrors themePreference's optional pattern — absent means "use default"
  // rather than a stored value, so no .default() is applied.
  language: z.enum(["ko", "en"]).optional(),

  // Icon theme selection. Absent = "minimal" (default).
  // "minimal" — monochrome outline icons; "material" — filled Material-style icons.
  // Renderer-only display setting; main process has no dedicated callback (generic patch
  // storage is sufficient).
  iconTheme: z.enum(["minimal", "material"]).optional(),

  // User keybinding overrides — a DELTA against the immutable default
  // KEYBINDINGS table (see shared/keybindings/overrides.ts for the
  // entry semantics: replace / null=unbind / absent=default). Absent =
  // all defaults. Accelerator strings are validated with the real
  // parser at this boundary; unknown command ids pass validation and
  // are dropped at apply time (version-skew tolerance).
  keybindingOverrides: KeybindingOverridesSchema.optional(),

  // User editor (Monaco) keybinding overrides — a DELTA against the
  // curated EDITOR_COMMANDS catalog (see shared/keybindings/
  // editor-commands.ts). Separate from `keybindingOverrides` because
  // these target Monaco's own keybinding service (applied via
  // monaco.editor.addKeybindingRules), not the app dispatcher table.
  // Same entry semantics (replace / null=unbind / absent=default);
  // command ids outside the curated catalog are dropped at apply time.
  editorKeybindingOverrides: KeybindingOverridesSchema.optional(),
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
