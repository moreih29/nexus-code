import { useDelayedLoading } from "../../../hooks/use-delayed-loading";
import type { SearchStatus } from "../../../state/stores/search";
import { LOADER_DELAY_MS } from "./status-header";

/** Applies the search and Source Control loading delay to a running search. */
export function useLoaderDelay(status: SearchStatus | undefined): boolean {
  return useDelayedLoading(status === "running", LOADER_DELAY_MS);
}
