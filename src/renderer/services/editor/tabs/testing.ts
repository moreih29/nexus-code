/**
 * Test-only entry point for the `tabs/` module group.
 *
 * Why a separate file:
 *   Production callers should not import reset / stop helpers — they
 *   exist purely to clear module-level state between test cases. Keeping
 *   them out of `tabs/index.ts` (the production barrel) makes the
 *   public API surface unambiguous: anything reachable from the
 *   production barrel is fair game in app code, and anything here is
 *   off-limits.
 *
 *   The functions themselves stay co-located with the state they reset
 *   (`pending-reveal.ts`, `promote-policy.ts`) so they retain access to
 *   the relevant module-private bindings; this file only re-exports
 *   them under a unified test-import path.
 */

export { __resetPendingEditorRevealsForTests } from "./pending-reveal";
export { stopPromoteOnDirtyPolicyForTests } from "./promote-policy";
