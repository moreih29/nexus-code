/**
 * Centralized timing constants used across processes.
 *
 * Why this file exists:
 * - Single discovery point for "how long is debounce X?" / "how long
 *   before idle Y?". Previously these were scattered across modules
 *   with names like `DEFAULT_TIMEOUT_MS` whose meaning was only legible
 *   from the call site.
 * - Magic numbers (e.g. `setTimeout(..., 300)` in file-watcher) are
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
 *
 * All values are in milliseconds. Suffix `_MS` is kept for symmetry with
 * existing call sites and for grep-ability.
 */

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * How long after the last fs change event before flushing the buffered
 * change set to renderers. Coalesces a burst of editor saves / git
 * checkouts into one broadcast.
 */
export const FS_WATCHER_DEBOUNCE_MS = 300;

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
 * Grace period between SIGTERM and SIGKILL when disposing a stdio LSP
 * adapter. 5s gives well-behaved servers time to flush state; ill-
 * behaved ones get force-killed.
 */
export const LSP_DISPOSE_GRACE_MS = 5_000;

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
 * Sweep interval for the toast dismissal timer. Single periodic sweep
 * avoids one-timer-per-toast races; 250ms is fast enough that a 4000ms
 * toast is dismissed within ~2 frames of its deadline.
 */
export const UI_TOAST_SWEEP_INTERVAL_MS = 250;
