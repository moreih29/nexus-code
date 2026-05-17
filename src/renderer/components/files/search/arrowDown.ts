import type { SearchSession } from "../../../state/stores/search";

/**
 * Pure guard: returns true when the search session has at least one result
 * and the arrow-down handoff from the search input to the first result row
 * should proceed. Exported for direct unit-testing without DOM / React.
 */
export function shouldHandleArrowDown(session: SearchSession | undefined): boolean {
  return !(session === undefined || session === null || session.results.length === 0);
}
