/**
 * surfaceError — the single renderer entry point for error presentation.
 *
 * DESIGN
 * ------
 * Every error in the renderer must flow through one call:
 *
 *   surfaceError(error, { surface: 'auto' | 'toast' | 'banner' | 'inline', onRetry? })
 *
 * The function enforces the category → legal surface matrix and routes to the
 * right presentation layer. Callers name their desired surface; the router
 * accepts, demotes, or refuses illegal combinations silently (with a log entry)
 * so callers never have to duplicate the policy.
 *
 * CATEGORY → LEGAL SURFACE MATRIX
 * ---------------------------------
 *   invalid-input → inline only (toast / banner refused — field errors belong inline)
 *   cancelled     → no surface at all (cancellation is normal, not an error)
 *   failed        → inline or banner (with optional retry); toast fallback when
 *                   neither inline nor banner is available ('auto' surface)
 *   bug           → toast only — shows generic user message + two action buttons:
 *                   "Copy details" (copies internalMessage + correlationId to clipboard)
 *                   "Open log" (opens the application log file)
 *                   inline / banner refused for bug (too raw a surface for unknown errors)
 *
 * INFORMATION SEPARATION
 * ----------------------
 * surfaceError owns the userMessage / internalMessage split:
 *   - userMessage: a short, friendly phrase shown in the UI (toast / banner / inline)
 *   - internalMessage: the raw error.message, stack, and any internal context — logged
 *     via the T1 facade logger and never shown to the user
 *
 * DOUBLE-SURFACE PREVENTION
 * -------------------------
 * surfaceError is the only place that writes to presentation layers for errors.
 * The T9 hook (useIpcAction) intentionally does NOT call surfaceError — the component
 * that owns the on-screen context calls it once with the result. Tests in
 * surface-error.test.ts verify that one surfaceError call produces exactly one surface.
 */

import type { AppError } from "../../../shared/error/app-error";
import { createLogger } from "../../../shared/log/renderer";
import { showToast } from "../../components/ui/toast";
import { copyText } from "../../utils/clipboard";

// ---------------------------------------------------------------------------
// Module-local logger
// ---------------------------------------------------------------------------

const log = createLogger("renderer");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which surface the caller prefers. The router may demote to a weaker
 * surface or refuse an illegal one — see the matrix above.
 *
 *   'inline'  — the error is rendered next to the triggering field / panel section.
 *               Callers must own an inline display area (e.g. a form field error slot).
 *   'banner'  — a persistent banner strip in the current panel.
 *               Callers must own a banner slot.
 *   'toast'   — a temporary notification toast in the bottom-right corner.
 *   'auto'    — surfaceError picks the safest surface for the category:
 *               failed → toast (no in-screen owner assumed), bug → toast.
 */
export type ErrorSurface = "inline" | "banner" | "toast" | "auto";

/** Callback-based surface descriptor returned when the error goes to an inline surface. */
export interface InlineSurfaceResult {
  readonly surface: "inline";
  /** User-facing message to render in the inline area. */
  readonly userMessage: string;
}

/** Callback-based surface descriptor returned when the error goes to a banner. */
export interface BannerSurfaceResult {
  readonly surface: "banner";
  /** User-facing message to render in the banner. */
  readonly userMessage: string;
  /** If provided, a retry button should be offered with this callback. */
  readonly onRetry?: () => void;
}

/** The error was silently suppressed (category === 'cancelled'). */
export interface SilentSurfaceResult {
  readonly surface: "silent";
}

/**
 * The error was sent to the toast system. Callers do not need to render
 * anything themselves.
 */
export interface ToastSurfaceResult {
  readonly surface: "toast";
}

export type SurfaceErrorResult =
  | InlineSurfaceResult
  | BannerSurfaceResult
  | ToastSurfaceResult
  | SilentSurfaceResult;

export interface SurfaceErrorOptions {
  /**
   * Desired presentation surface. See the matrix in the module doc comment.
   * The router may substitute a legal surface when the requested one is illegal
   * for the error's category.
   */
  surface: ErrorSurface;
  /**
   * Optional retry callback. Offered as a button when the surface supports it
   * (banner, action toast). Not applicable for invalid-input (no retry) or
   * cancelled/bug.
   */
  onRetry?: () => void;
}

// ---------------------------------------------------------------------------
// User-message catalogue
// ---------------------------------------------------------------------------

/**
 * Derives a short, safe user-facing message from an AppError.
 *
 * The `message` field on AppError is an internal string (may contain paths,
 * stack fragments, or technical codes). We never pass it to the user directly.
 * Instead we produce a generic phrase based on category and — for 'failed' —
 * try to map the domain code to a friendlier phrase via the fs-code table.
 *
 * All raw paths, stack traces, and technical detail stay inside this module
 * and go to the log only.
 */
function buildUserMessage(error: AppError): string {
  switch (error.category) {
    case "cancelled":
      // Cancelled errors never reach the user surface. This branch is a
      // defensive fallback only.
      return "The operation was cancelled.";

    case "invalid-input":
      return buildInvalidInputMessage(error);

    case "failed":
      return buildFailedMessage(error);

    case "bug":
      // Bug category always shows a generic message — never internal detail.
      return "Something went wrong. Check the log for details.";
  }
}

/** Friendly message for invalid-input errors, with optional fs-code mapping. */
function buildInvalidInputMessage(error: AppError): string {
  if (error.domain === "fs" && error.code) {
    return fsCodeToUserMessage(error.code) ?? "The input is invalid.";
  }
  return "The input is invalid.";
}

/** Friendly message for failed errors with fs / git code awareness. */
function buildFailedMessage(error: AppError): string {
  if (error.domain === "fs" && error.code) {
    return fsCodeToUserMessage(error.code) ?? "The operation failed.";
  }
  if (error.domain === "git" && error.code) {
    return gitCodeToUserMessage(error.code) ?? "The operation failed.";
  }
  return "The operation failed.";
}

/**
 * Maps FsErrorCode strings to user-friendly phrases.
 * These are the same messages previously scattered in toFsToast and
 * fileErrorMessage — centralised here so surfaceError is the single owner.
 *
 * Returns undefined for unknown codes so callers fall back to the generic phrase.
 */
function fsCodeToUserMessage(code: string): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "File or folder not found.";
    case "PERMISSION_DENIED":
      return "Permission denied.";
    case "ALREADY_EXISTS":
      return "A file or folder with that name already exists.";
    case "IS_DIRECTORY":
      return "Cannot open a directory as a file.";
    case "NOT_DIRECTORY":
      return "Path is not a folder.";
    case "TOO_LARGE":
      return "File too large to open.";
    case "OUT_OF_WORKSPACE":
      return "This path is outside the workspace.";
    case "NOT_EMPTY":
      return "Folder is not empty.";
    case "CROSS_DEVICE":
      return "Can't move across filesystems.";
    default:
      return undefined;
  }
}

/** Maps git domain codes to user-friendly phrases. Extensible as new codes emerge. */
function gitCodeToUserMessage(code: string): string | undefined {
  switch (code) {
    case "not-repo":
      return "Not a git repository.";
    case "auth":
      return "Authentication failed.";
    case "no-upstream":
      return "No upstream branch is configured.";
    case "conflict":
      return "There is a conflict that must be resolved.";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal message builder — for log only, never shown to the user
// ---------------------------------------------------------------------------

/**
 * Builds the internal log message that contains full technical context.
 * This string is passed to the T1 facade logger only — never to any user surface.
 */
function buildInternalMessage(error: AppError): string {
  const parts: string[] = [
    `[${error.category}]`,
    error.domain ? `domain=${error.domain}` : null,
    error.code ? `code=${error.code}` : null,
    error.correlationId ? `correlationId=${error.correlationId}` : null,
    `message=${error.message}`,
  ].filter(Boolean) as string[];
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Bug-toast detail string — goes to clipboard only, never rendered
// ---------------------------------------------------------------------------

/**
 * Assembles the text that "Copy details" copies to the clipboard.
 * Contains category, message, domain, code, and correlationId — technical
 * context that lets a developer reproduce the issue. Never displayed in UI.
 */
function buildBugClipboardDetail(error: AppError): string {
  const lines: string[] = [
    `Category: ${error.category}`,
    error.domain ? `Domain: ${error.domain}` : null,
    error.code ? `Code: ${error.code}` : null,
    `Message: ${error.message}`,
    error.correlationId ? `CorrelationId: ${error.correlationId}` : null,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Surface router — enforces the category → legal surface matrix
// ---------------------------------------------------------------------------

/**
 * Routes the error to the appropriate presentation layer according to
 * the category × requested-surface matrix.
 *
 * Single entry point for all error surfacing in the renderer.
 * One call = one surface. Never call twice for the same error.
 */
export function surfaceError(error: AppError, options: SurfaceErrorOptions): SurfaceErrorResult {
  const { surface, onRetry } = options;

  switch (error.category) {
    case "cancelled":
      // Cancelled is not an error — suppress silently. No log needed.
      return { surface: "silent" };

    case "invalid-input":
      return routeInvalidInput(error, surface);

    case "failed":
      return routeFailed(error, surface, onRetry);

    case "bug":
      return routeBug(error, surface);
  }
}

// ---------------------------------------------------------------------------
// Category-specific routers
// ---------------------------------------------------------------------------

/**
 * invalid-input: inline only.
 * Toast and banner are refused (demoted with a log warning) because
 * validation errors belong adjacent to the triggering input, not in a
 * global notification layer.
 */
function routeInvalidInput(error: AppError, surface: ErrorSurface): SurfaceErrorResult {
  const userMessage = buildUserMessage(error);

  if (surface === "toast" || surface === "banner") {
    // Illegal surface — demote to inline and log the policy violation.
    log.warn(
      `surfaceError: invalid-input routed to inline (requested '${surface}' is illegal for this category). ${buildInternalMessage(error)}`,
    );
  }

  // invalid-input never reaches the log as an 'error' — it is the caller's
  // fault (bad input), not an application error. No error log entry.
  return { surface: "inline", userMessage };
}

/**
 * failed: inline or banner (caller's choice), with optional retry.
 * 'auto' and any unrecognised surface fall back to toast.
 * Bug is not applicable for this category.
 */
function routeFailed(
  error: AppError,
  surface: ErrorSurface,
  onRetry?: () => void,
): SurfaceErrorResult {
  const userMessage = buildUserMessage(error);
  const internalMessage = buildInternalMessage(error);

  // Log the failure at warn level — expected failures are not bugs.
  log.warn(`surfaceError: failed — ${internalMessage}`, {
    correlationId: error.correlationId,
  });

  if (surface === "inline") {
    return { surface: "inline", userMessage };
  }

  if (surface === "banner") {
    return { surface: "banner", userMessage, onRetry };
  }

  // 'toast' or 'auto': fall back to toast (no caller-owned surface needed).
  const actions = onRetry ? [{ label: "Retry", onAction: onRetry }] : [];
  showToast({ kind: "error", message: userMessage, actions });
  return { surface: "toast" };
}

/**
 * bug: toast only, with "Copy details" and "Open log" action buttons.
 * inline and banner are refused — they are too specific a surface for
 * an unexpected error whose cause is unknown.
 */
function routeBug(error: AppError, surface: ErrorSurface): SurfaceErrorResult {
  const userMessage = buildUserMessage(error);
  const internalMessage = buildInternalMessage(error);

  // Bug-category errors are always logged at error level — they represent
  // invariant violations that a developer must investigate.
  log.error(`surfaceError: bug — ${internalMessage}`, {
    correlationId: error.correlationId,
  });

  if (surface === "inline" || surface === "banner") {
    // Illegal surface — demote to toast and log the policy violation.
    log.warn(
      `surfaceError: bug demoted to toast (requested '${surface}' is illegal for bug category)`,
    );
  }

  const clipboardDetail = buildBugClipboardDetail(error);

  showToast({
    kind: "error",
    message: userMessage,
    actions: [
      {
        label: "Copy details",
        // Writes internal context to clipboard — not to any visible surface.
        onAction: () => copyText(clipboardDetail),
      },
      {
        label: "Open log",
        // Opens the application log file via the system shell handler.
        // Best-effort: if the shell IPC is unavailable the user can find
        // the log at their platform's electron-log path manually.
        onAction: openLogFile,
      },
    ],
  });

  return { surface: "toast" };
}

// ---------------------------------------------------------------------------
// Log file opener — best-effort, shell IPC
// ---------------------------------------------------------------------------

/**
 * Asks the main process to reveal the electron-log file in the OS file manager.
 * Calls the "system" IPC channel's "openPathExternal" method with the log path
 * queried from electron-log's renderer transport.
 *
 * Best-effort: failures are swallowed — the user can still use "Copy details"
 * to capture error context even if the log file cannot be opened.
 */
function openLogFile(): void {
  // electron-log exposes the log path through its renderer transport.
  // We use `import("electron-log/renderer")` dynamically to keep this
  // module free of a hard dependency on the electron-log renderer bundle
  // at the static import layer (tests mock it without issue).
  import("electron-log/renderer")
    .then((mod) => {
      // The renderer transport surfaces the path as `transports.file.getFile().path`.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic runtime access to electron-log internals
      const logPath = (mod.default as any)?.transports?.file?.getFile?.()?.path as
        | string
        | undefined;
      if (!logPath) return;

      // The "system" IPC channel is always registered (see main/features/shell/ipc.ts).
      // We import ipcCallResult lazily to keep this module testable without the IPC bridge.
      // Fire-and-forget: open log file in OS default app; no UI feedback required.
      import("../../ipc/client")
        .then(({ ipcCallResult }) => {
          void ipcCallResult("system", "openPathExternal", { absPath: logPath });
        })
        .catch(() => {
          // IPC bridge unavailable (e.g. test environment) — silently skip.
        });
    })
    .catch(() => {
      // electron-log renderer bundle not available — silently skip.
    });
}
