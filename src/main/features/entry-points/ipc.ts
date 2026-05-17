/**
 * entry-points channel — registers folder bookmark and connection profile
 * IPC handlers, delegating all persistence to GlobalStorage (T1).
 */

import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";
import type { GlobalStorage } from "../../infra/storage/global-storage";

const fb = ipcContract.folderBookmark.call;
const cp = ipcContract.connectionProfile.call;

/**
 * Register folderBookmark and connectionProfile IPC channels, wired to the
 * provided GlobalStorage instance.
 */
export function registerEntryPointsChannels(storage: GlobalStorage): void {
  register("folderBookmark", {
    call: {
      list: (_args: unknown) => {
        validateArgs(fb.list.args, _args);
        return storage.listFolderBookmarks();
      },
      record: (args: unknown) => {
        const params = validateArgs(fb.record.args, args);
        storage.recordFolderBookmark(params);
      },
      setFavorite: (args: unknown) => {
        const { id, favorite } = validateArgs(fb.setFavorite.args, args);
        storage.setFolderBookmarkFavorite(id, favorite);
      },
      remove: (args: unknown) => {
        const { id } = validateArgs(fb.remove.args, args);
        storage.removeFolderBookmark(id);
      },
    },
    listen: {},
  });

  register("connectionProfile", {
    call: {
      list: (_args: unknown) => {
        validateArgs(cp.list.args, _args);
        return storage.listConnectionProfiles();
      },
      save: (args: unknown) => {
        const params = validateArgs(cp.save.args, args);
        storage.recordConnectionProfile({
          id: params.id,
          label: params.label,
          host: params.host,
          user: params.user,
          port: params.port,
          identityFile: params.identityFile,
          authMode: params.authMode,
        });
      },
      setFavorite: (args: unknown) => {
        const { id, favorite } = validateArgs(cp.setFavorite.args, args);
        storage.setConnectionProfileFavorite(id, favorite);
      },
      remove: (args: unknown) => {
        const { id } = validateArgs(cp.remove.args, args);
        storage.removeConnectionProfile(id);
      },
    },
    listen: {},
  });
}
