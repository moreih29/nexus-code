/**
 * ConflictResolvedBanner — editor-chrome banner for fully-resolved merge conflicts.
 *
 * Appears above the Monaco editor when both conditions hold simultaneously:
 *   (a) Git still reports the open file as conflicted (conflictType !== null), AND
 *   (b) The editor buffer no longer contains any conflict markers.
 *
 * The complement of the per-block CodeLens: the CodeLens handles partial
 * resolution while markers are present; this banner fires once the last marker
 * is gone and prompts the user to run `git add` via markResolved.
 *
 * This module is intentionally free of git-store and IPC imports so that it
 * can be imported in tests that do not stub those subsystems. All external
 * state is passed in by the caller (EditorView) as props.
 */

// ---------------------------------------------------------------------------
// Visibility predicate — pure, testable
// ---------------------------------------------------------------------------

/**
 * Returns true when the editor should display the "all conflicts resolved"
 * banner. Both conditions must hold:
 *
 *   - `isConflicted`  — the git index still carries this file in the merge
 *                       group (conflictType !== null).
 *   - `hasMarkers`    — whether the buffer currently contains `<<<<<<<` markers.
 *
 * The banner is suppressed when markers remain (the CodeLens handles that
 * state) and when the file leaves the conflict list (banner self-hides).
 */
export function shouldShowConflictResolvedBanner(
  isConflicted: boolean,
  hasMarkers: boolean,
): boolean {
  return isConflicted && !hasMarkers;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ConflictResolvedBannerProps {
  /** True when git still lists this file as conflicted (conflictType !== null). */
  isConflicted: boolean;
  /** True when the editor buffer contains `<<<<<<<` conflict markers. */
  hasMarkers: boolean;
  /** Invoked when the user clicks "해결로 표시" to run markResolved. */
  onMarkResolved: () => void;
}

/**
 * Renders the "all conflicts resolved" affordance above the Monaco editor.
 *
 * Visibility is derived from the predicate — the caller is responsible for
 * providing up-to-date `isConflicted` and `hasMarkers` values. Visual tokens
 * mirror the existing `ReadOnlyBanner` class tuple so contrast is consistent
 * with the documented empirical audit.
 */
export function ConflictResolvedBanner({
  isConflicted,
  hasMarkers,
  onMarkResolved,
}: ConflictResolvedBannerProps) {
  if (!shouldShowConflictResolvedBanner(isConflicted, hasMarkers)) return null;

  return (
    <div
      className="flex items-center justify-between shrink-0 h-6 px-3 bg-frosted-veil border-b border-mist-border text-app-ui-xs app-status-banner-text"
      role="status"
      aria-live="polite"
    >
      <span>✓ 모든 충돌 해결됨</span>
      <button
        type="button"
        className="text-app-ui-xs app-status-banner-text hover:opacity-80 cursor-pointer bg-transparent border-0 p-0"
        onClick={onMarkResolved}
      >
        해결로 표시
      </button>
    </div>
  );
}
