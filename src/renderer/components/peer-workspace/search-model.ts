import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { SearchRange } from "../../../shared/search/types";
import { refreshPeerSessions } from "../../services/remote/room";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import type { FileGroup } from "../../state/stores/search";
import { peerPathKey, peerSearchResultPath } from "../../utils/peer-path";

const PREVIEW_LIMIT = 512;
const PREVIEW_CONTEXT = 64;

export function peerSearchResults(root: string, reply: RpcResult<"files.search">) {
  const groups = new Map<string, FileGroup>();
  let matchesFound = 0;
  for (const file of reply.files) {
    if (file.matches.length === 0 || peerSearchResultPath(root, file.path) === null) continue;
    let group = groups.get(file.path);
    if (!group) {
      group = { relPath: file.path, expanded: true, matches: [] };
      groups.set(file.path, group);
    }
    for (const { line, column, length, text, textStart } of file.matches) {
      const offset = Math.min(
        Math.max(0, column - (textStart ?? 0) - PREVIEW_CONTEXT),
        Math.max(0, text.length - PREVIEW_LIMIT),
      );
      group.matches.push({
        range: { line: line - 1, startCol: column, endCol: column + length },
        preview: text.slice(offset, offset + PREVIEW_LIMIT),
        ...((textStart !== undefined || offset > 0) && { previewStart: (textStart ?? 0) + offset }),
      });
      matchesFound++;
    }
  }
  return { groups: [...groups.values()], matchesFound, truncated: reply.truncated === true };
}

export function parsePeerSearchFilters(input: string, folders: boolean): string[] | null {
  const filters = [
    ...new Set(
      input
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  if (filters.length > 32) return null;
  const valid = filters.every((filter) => {
    const name = folders ? filter.replace(/\/$/, "") : filter;
    return (
      filter.length <= 256 &&
      name.length > 0 &&
      !name.includes("\0") &&
      !name.replace(/^\*\./, "").includes("*") &&
      !name.includes("/")
    );
  });
  return valid ? filters : null;
}

export function peerSearchErrorKey(kind: string) {
  if (kind === "unsupported") return "peerWorkspace.updateNeeded";
  if (kind === "permission-denied") return "peerWorkspace.accessDenied";
  return "peerWorkspace.connectionUnavailable";
}

export function markMissingPeer(target: PeerWorkspaceTarget): void {
  usePeerWorkspaceStore.getState().markMissing(peerTargetId(target));
  refreshPeerSessions(target.deviceId);
}

export function openPeerResult(
  target: PeerWorkspaceTarget,
  relative: string,
  canRead: boolean,
  range?: SearchRange,
): void {
  const path = peerSearchResultPath(target.workspace.path, relative);
  if (path === null) return;
  const id = peerTargetId(target);
  const store = usePeerWorkspaceStore.getState();
  if (!canRead && !store.views[id]?.tabs.some((tab) => peerPathKey(tab.path) === peerPathKey(path)))
    return;
  store.openFile(id, path, range && { line: range.line + 1, column: range.startCol + 1 });
}
