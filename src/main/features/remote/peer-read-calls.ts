import { ipcContract } from "../../../shared/ipc/contract";
import type { IpcResult } from "../../../shared/ipc/result";
import { type CallContext, validateArgs } from "../../infra/ipc-router";
import type { RemoteRoom } from "./room";
import { SEARCH_TIME_MS } from "./search";

/**
 * File, Git and host-load RPCs behind the renderer's peer read calls. The
 * byte reader shares files.read.
 */
export const PEER_READ_METHODS = {
  peerFilesList: "files.list",
  peerFilesFind: "files.find",
  peerFilesSearch: "files.search",
  peerFilesRead: "files.read",
  peerGitStatus: "git.status",
  peerGitDiff: "git.diff",
  peerGitLog: "git.log",
  peerGitShow: "git.show",
  peerSystemStats: "system.stats",
} as const;

const c = ipcContract.remote.call;

// The server can spend its full search budget before sending a truncated answer.
const PEER_SEARCH_TIMEOUT_MS = SEARCH_TIME_MS + 5_000;

export function peerReadCalls(
  inRoom: () => Pick<RemoteRoom, "request">,
  askPeer: <T>(question: () => Promise<T>) => Promise<IpcResult<T>>,
) {
  return {
    peerFilesList: (args: unknown) => {
      const { deviceId, ...params } = validateArgs(c.peerFilesList.args, args);
      return askPeer(() => inRoom().request(deviceId, PEER_READ_METHODS.peerFilesList, params));
    },
    peerFilesFind: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerFilesFind.args, args);
      return askPeer(() =>
        inRoom().request(deviceId, PEER_READ_METHODS.peerFilesFind, params, undefined, ctx?.signal),
      );
    },
    peerFilesSearch: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerFilesSearch.args, args);
      return askPeer(() =>
        inRoom().request(
          deviceId,
          PEER_READ_METHODS.peerFilesSearch,
          params,
          PEER_SEARCH_TIMEOUT_MS,
          ctx?.signal,
        ),
      );
    },
    peerGitStatus: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerGitStatus.args, args);
      return askPeer(() =>
        inRoom().request(deviceId, PEER_READ_METHODS.peerGitStatus, params, undefined, ctx?.signal),
      );
    },
    peerGitDiff: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerGitDiff.args, args);
      return askPeer(() =>
        inRoom().request(deviceId, PEER_READ_METHODS.peerGitDiff, params, undefined, ctx?.signal),
      );
    },
    peerGitLog: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerGitLog.args, args);
      return askPeer(() =>
        inRoom().request(deviceId, PEER_READ_METHODS.peerGitLog, params, undefined, ctx?.signal),
      );
    },
    peerGitShow: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerGitShow.args, args);
      return askPeer(() =>
        inRoom().request(deviceId, PEER_READ_METHODS.peerGitShow, params, undefined, ctx?.signal),
      );
    },
    peerSystemStats: (args: unknown, ctx?: CallContext) => {
      const { deviceId, ...params } = validateArgs(c.peerSystemStats.args, args);
      return askPeer(() =>
        inRoom().request(
          deviceId,
          PEER_READ_METHODS.peerSystemStats,
          params,
          undefined,
          ctx?.signal,
        ),
      );
    },
  };
}
