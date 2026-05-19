/**
 * Unified application error taxonomy.
 *
 * DESIGN
 * ------
 * Four categories capture every failure mode a handler can produce:
 *
 *   - `invalid-input`  The caller supplied malformed or invalid arguments.
 *                      Retrying with the same arguments will always fail.
 *   - `cancelled`      The operation was aborted by the user or a signal.
 *                      Not a failure — the caller typically suppresses UI.
 *   - `failed`         A domain-level expected failure (not found, auth
 *                      rejected, conflict, …). The caller can react to the
 *                      specific `code` for recovery UI.
 *   - `bug`            An unexpected invariant violation. The caller should
 *                      surface a generic error message; logging is mandatory.
 *
 * Domain codes (`code`) are preserved verbatim from their source taxonomy
 * (GitErrorKind, FsErrorCode, SshErrorCode, …) so UI branching logic that
 * currently inspects those values continues to work unchanged.
 *
 * The `hint` field generalises GitActionHint to be domain-independent; the
 * same discriminated-union structure is reused because every domain could
 * in principle provide actionable recovery hints.
 *
 * This type is the T2 data contract consumed by T3 (IPC contract),
 * T8 (error surface), T9 (useIpcAction), and T10 (partial failures).
 */

import { z } from "zod";
import { GitActionHintSchema } from "../git/types";

// ---------------------------------------------------------------------------
// Category — exhaustive, closed union
// ---------------------------------------------------------------------------

/**
 * Top-level classification of every application error.
 *
 * The four values are intentionally narrow so switch exhaustiveness checks
 * on `category` give compile-time guarantees to UI code.
 */
export const APP_ERROR_CATEGORIES = ["invalid-input", "cancelled", "failed", "bug"] as const;

export const AppErrorCategorySchema = z.enum(APP_ERROR_CATEGORIES);
export type AppErrorCategory = z.infer<typeof AppErrorCategorySchema>;

// ---------------------------------------------------------------------------
// Domain — optional, open-ended tag for code namespacing
// ---------------------------------------------------------------------------

/**
 * Named domains that carry their own code taxonomies.
 * Handlers outside these domains omit `domain` and `code`.
 */
export const APP_ERROR_DOMAINS = ["git", "fs", "ssh"] as const;

export const AppErrorDomainSchema = z.enum(APP_ERROR_DOMAINS);
export type AppErrorDomain = z.infer<typeof AppErrorDomainSchema>;

// ---------------------------------------------------------------------------
// ActionHint — domain-independent alias
// ---------------------------------------------------------------------------

/**
 * Actionable recovery hint attached to an error so the renderer can offer
 * a one-click recovery path instead of a raw error toast.
 *
 * Currently structurally identical to GitActionHint; other domains will
 * extend this union as they introduce their own recovery paths.
 */
export const ActionHintSchema = GitActionHintSchema;
export type ActionHint = z.infer<typeof ActionHintSchema>;

// ---------------------------------------------------------------------------
// AppError — unified error type
// ---------------------------------------------------------------------------

export const AppErrorSchema = z.object({
  /**
   * Top-level classification used by callers to branch on severity and
   * recovery strategy without inspecting the domain-specific `code`.
   */
  category: AppErrorCategorySchema,

  /**
   * Named domain that owns the `code` taxonomy. Omit when no domain-
   * specific code is attached.
   */
  domain: AppErrorDomainSchema.optional(),

  /**
   * Domain-specific error code (e.g. `"auth"`, `"NOT_FOUND"`,
   * `"ssh.auth-failed"`). Preserved verbatim from the source taxonomy so
   * existing UI branching on these values continues to work unchanged.
   */
  code: z.string().optional(),

  /** Human-readable description for logging and display. */
  message: z.string(),

  /**
   * Actionable recovery hint the renderer can surface as a one-click
   * button instead of a raw error toast.
   */
  hint: ActionHintSchema.optional(),

  /**
   * Correlation identifier threading the error back to a specific
   * protocol request or log entry. Set by transport layers; domain
   * handlers do not need to populate this field.
   */
  correlationId: z.string().optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

// ---------------------------------------------------------------------------
// Constructor helpers
// ---------------------------------------------------------------------------

/**
 * Build an AppError with category `invalid-input`.
 * Use when the caller supplied malformed or invalid arguments.
 */
export function appErrorInvalidInput(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "invalid-input", message, ...options };
}

/**
 * Build an AppError with category `cancelled`.
 * Use when the operation was aborted by the user or a signal.
 */
export function appErrorCancelled(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "cancelled", message, ...options };
}

/**
 * Build an AppError with category `failed`.
 * Use for domain-level expected failures a caller can react to.
 */
export function appErrorFailed(
  message: string,
  options: Pick<AppError, "domain" | "code" | "hint" | "correlationId"> = {},
): AppError {
  return { category: "failed", message, ...options };
}

/**
 * Build an AppError with category `bug`.
 * Use for unexpected invariant violations that should be logged.
 */
export function appErrorBug(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "bug", message, ...options };
}
