/**
 * Local Source Control selector hook that keeps component imports scoped to
 * the git panel directory while delegating state ownership to useGitStore.
 */
import { type GitSession, useGitSession as useStoreGitSession } from "../../../state/stores/git";

export function useGitSession(workspaceId: string): GitSession | undefined {
  return useStoreGitSession(workspaceId);
}
