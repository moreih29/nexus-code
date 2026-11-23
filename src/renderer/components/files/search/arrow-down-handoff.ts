import type { SearchSession } from "../../../state/stores/search";

export function shouldHandleArrowDown(session: SearchSession | undefined): boolean {
  return !(session === undefined || session === null || session.results.length === 0);
}
