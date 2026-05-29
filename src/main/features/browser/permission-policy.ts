/**
 * Pure permission decision resolver for the embedded browser view.
 *
 * WHY PURE / NO ELECTRON IMPORT
 * Keeping this file free of Electron (and any stateful service) imports means
 * it can be unit-tested without mocking, instantiated in any process context,
 * and reasoned about as a deterministic function.  The adapter layer that
 * calls `setPermissionRequestHandler` is responsible for reading workspace
 * state and mapping the returned PermissionDecision to an allow/deny callback.
 *
 * PRIORITY ORDER (enforced by resolvePermission)
 *  1. Unknown permission → "block"  (unauditable request, always reject)
 *  2. Global toggle ON  → "allow"   (user opted in globally; beats remembered block)
 *  3. Remembered allow  → "allow"
 *  4. Remembered block  → "block"
 *  5. No memory         → "ask"
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PermissionDecision = "allow" | "block" | "ask";

export interface PermissionResolverInput {
  /** Whether the workspace-level global permission toggle is ON. */
  readonly globalAllowed: boolean;
  /** Persisted per-(workspace, origin, permission) decision, or null if absent. */
  readonly remembered: "allow" | "block" | null;
  /** False when the permission string is unrecognised or literally "unknown". */
  readonly isKnownPermission: boolean;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a single permission request to a deterministic decision.
 *
 * The five-step priority chain is documented above.  This function has no
 * side-effects and no dependencies outside this file.
 */
export function resolvePermission(input: PermissionResolverInput): PermissionDecision {
  const { globalAllowed, remembered, isKnownPermission } = input;

  // 1. Unknown / unrecognised permission — always block.
  if (!isKnownPermission) {
    return "block";
  }

  // 2. Global allow toggle is ON — supersedes any remembered block.
  if (globalAllowed) {
    return "allow";
  }

  // 3. Remembered allow.
  if (remembered === "allow") {
    return "allow";
  }

  // 4. Remembered block.
  if (remembered === "block") {
    return "block";
  }

  // 5. No remembered decision — surface to user.
  return "ask";
}
