/**
 * Add-Workspace service group.
 *
 * Encapsulates all IPC calls for the Add Workspace dialog flow so that
 * components under `components/workspace/add-workspace/` do not import
 * `ipc/client` directly.
 */

// Connection profiles
export type { SaveConnectionProfileArgs } from "./connection-profiles";
export {
  fetchConnectionProfiles,
  listConnectionProfiles,
  removeConnectionProfile,
  saveConnectionProfile,
  saveConnectionProfileResult,
  setConnectionProfileFavorite,
} from "./connection-profiles";
// Folder bookmarks
export type { RecordLocalBookmarkArgs, RecordSshBookmarkArgs } from "./folder-bookmarks";
export {
  listFolderBookmarks,
  recordLocalBookmark,
  recordSshBookmark,
  removeFolderBookmark,
  setFolderBookmarkFavorite,
} from "./folder-bookmarks";
// SSH browse session
export type { BrowseSessionInfo, BrowseSessionResult, OpenBrowseSessionArgs } from "./ssh-browse";
export {
  browseSshSession,
  closeSshBrowseSession,
  openSshBrowseSession,
  prefetchSshDirectory,
  subscribeSshBrowseProgress,
} from "./ssh-browse";
// Workspace creation + directory picker
export type { CreateSshWorkspaceArgs } from "./workspace-create";
export {
  createLocalWorkspace,
  createSshWorkspace,
  listSshConfigHosts,
  pickLocalDirectory,
} from "./workspace-create";
