/**
 * Centralized timing constants used across processes.
 *
 * Why this file exists:
 * - Single discovery point for "how long is debounce X?" / "how long
 *   before idle Y?". Previously these were scattered across modules
 *   with names like `DEFAULT_TIMEOUT_MS` whose meaning was only legible
 *   from the call site.
 * - Magic numbers (e.g. `setTimeout(..., 300)` in watcher bridges) are
 *   eliminated — every timing value has a name and a comment.
 * - Tests can override per-module by injecting different values where
 *   the call site accepts an option (e.g. `LspManagerOpts.idleTimeoutMs`).
 *
 * Grouping convention:
 * - "FS_*"     filesystem watching / persistence
 * - "LSP_*"    language server lifecycle
 * - "STATE_*"  zustand-store / app-state persistence
 * - "UI_*"     visible UI affordances (tooltips, toasts, loading flashes)
 * - "CHORD_*"  keyboard chord (multi-step) timing
 * - "GIT_*"    Source Control panel refresh / persistence cadence
 *
 * All values are in milliseconds. Suffix `_MS` is kept for symmetry with
 * existing call sites and for grep-ability.
 */

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * How long after the last expand/collapse before persisting the
 * expanded-set to appState. Coalesces a rapid succession of toggles
 * (e.g. keyboard-collapsing several rows) into a single IPC write.
 */
export const FS_EXPANDED_SAVE_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Language servers
// ---------------------------------------------------------------------------

/**
 * Default idle window before a workspace's LSP adapter is gracefully
 * shut down. 30 minutes is long enough that "open file, switch tabs
 * for a while, come back" doesn't pay a re-spawn cost, but short
 * enough that abandoned workspaces don't leak processes.
 */
export const LSP_DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * Maximum number of workspaces whose LSP servers can be live
 * simultaneously. This is a **safety net**, not the primary resource
 * control — users govern per-workspace per-language LSP allocation
 * explicitly via the sidebar chips and the Workspaces settings panel
 * (new workspaces default to no LSP enabled). The cap only kicks in
 * if the user has opted four workspaces into LSP at once, which on
 * 16GB machines (4× tsserver ≈ 6–10GB) is the practical limit before
 * macOS begins page-compressing aggressively and inter-process
 * latency spikes into seconds.
 *
 * The evicted workspace's renderer-side model entries are notified via
 * `lsp:workspaceReset` so the next interaction triggers a fresh
 * didOpen and respawn — see services/editor/model/cache.ts.
 */
export const LSP_MAX_ACTIVE_WORKSPACES = 4;

// ---------------------------------------------------------------------------
// LSP per-request timeouts
//
// Even with healthy routing, a memory-pressured tsserver can stall a
// request for tens of seconds. Without a timeout the renderer's hover /
// completion widget shows "Loading…" indefinitely. We bound each request
// kind to a reasonable maximum and resolve with an empty response on
// expiry — the request is also cancelled at the server boundary so
// tsserver doesn't keep working on a result nobody is waiting for.
//
// The values are tuned per-method:
// - hover / documentHighlight: low (interactive feedback); a hover that
//   takes 8s+ is effectively useless.
// - completion / references / workspaceSymbol: medium (user explicitly
//   waits, the result is worth more time).
// - semanticTokens / documentSymbol: medium (whole-file work, runs once
//   per open).
// ---------------------------------------------------------------------------

/**
 * How many consecutive request timeouts on the same LSP server trigger
 * an automatic wedge-restart. The server is disposed and a
 * `workspaceReset(workspaceId, languageId)` broadcast lets the renderer
 * clear `lspOpened`; the next user interaction naturally respawns the
 * server. Three is the threshold: a single transient stall (tsserver
 * GC pause) should not trigger a restart, but three consecutive hangs
 * indicates the server is truly stuck.
 */
export const LSP_CONSECUTIVE_TIMEOUT_LIMIT = 3;

/**
 * Grace window after an LSP server spawns during which consecutive
 * timeouts are NOT counted toward the wedge-restart limit. Some
 * language servers (tsserver, basedpyright) are slow to finish
 * initializing and will time out on the first requests; counting those
 * toward the wedge threshold would cause unnecessary rapid cycling.
 */
export const LSP_SERVER_WEDGE_GRACE_MS = 60_000;

export const LSP_HOVER_TIMEOUT_MS = 8_000;
export const LSP_DEFINITION_TIMEOUT_MS = 10_000;
export const LSP_COMPLETION_TIMEOUT_MS = 15_000;
export const LSP_REFERENCES_TIMEOUT_MS = 15_000;
export const LSP_DOCUMENT_HIGHLIGHT_TIMEOUT_MS = 5_000;
export const LSP_DOCUMENT_SYMBOL_TIMEOUT_MS = 10_000;
export const LSP_WORKSPACE_SYMBOL_TIMEOUT_MS = 15_000;
export const LSP_SEMANTIC_TOKENS_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/**
 * How long the layout/tabs persistence subscriber waits after the last
 * store change before writing to appState. Tuned to absorb burst
 * mutations (drag-drop, tab close cascades) without delaying user-
 * visible reactions.
 */
export const STATE_PERSIST_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Keyboard chord
// ---------------------------------------------------------------------------

/**
 * Default time window between leader and secondary in a multi-step
 * chord (e.g. ⌘K …). After this expires, the pending state clears.
 */
export const CHORD_DEFAULT_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// UI affordances
// ---------------------------------------------------------------------------

/**
 * Delay before a Radix Tooltip becomes visible after the user hovers a
 * trigger. Lower than the Radix default (700) to feel responsive in a
 * tab bar where users hover-scan repeatedly.
 */
export const UI_TOOLTIP_DELAY_MS = 600;

/**
 * Delay before a "loading…" affordance is shown for fast operations.
 * Anything that resolves under this threshold renders without the
 * flash, avoiding visual jitter for cached / instant results.
 */
export const UI_LOADING_FLASH_DELAY_MS = 200;

/** Auto-dismiss for info-kind toasts. */
export const UI_TOAST_INFO_MS = 4_000;

/** Auto-dismiss for error-kind toasts. Held longer so users can read after focus shift. */
export const UI_TOAST_ERROR_MS = 6_000;

/**
 * Auto-dismiss for warning-kind toasts. Matches the error duration — warnings
 * are user-decision points (e.g. "folder is not empty") that the user may need
 * to read after switching focus to investigate.
 */
export const UI_TOAST_WARNING_MS = 6_000;

/**
 * Sweep interval for the toast dismissal timer. Single periodic sweep
 * avoids one-timer-per-toast races; 250ms is fast enough that a 4000ms
 * toast is dismissed within ~2 frames of its deadline.
 */
export const UI_TOAST_SWEEP_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Source Control (Git)
// ---------------------------------------------------------------------------

/**
 * Per-workspace trailing-debounce window for the StatusCoalescer. Bursty
 * `.git/refs/...` events from a `git fetch` collapse into one `getStatus`
 * + broadcast within this window, preventing renderer storms after sync.
 */
export const GIT_STATUS_COALESCE_DEBOUNCE_MS = 100;

/**
 * Idle window after the last keystroke before the renderer persists the
 * commit-message draft to per-workspace storage. Tuned to absorb burst
 * typing (one IPC write per "thought," not per character).
 */
export const GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS = 500;

/**
 * Renderer-side debounce for fs.changed-driven passive status hints.
 * Working-tree edits don't always touch `.git/`, so the renderer pulls a
 * fresh snapshot via `getStatus` rather than waiting on the watcher; this
 * window collapses save-cascades into one call.
 */
export const GIT_STATUS_HINT_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Browser tabs
// ---------------------------------------------------------------------------

/**
 * Trailing-edge debounce window for persisting a browser tab's `lastUrl`.
 * URL changes can arrive in rapid succession during page redirects and
 * client-side navigation; this window coalesces them into a single store
 * write per tab so persistence isn't hammered on every navigation step.
 */
export const BROWSER_LAST_URL_SAVE_DEBOUNCE_MS = 250;
