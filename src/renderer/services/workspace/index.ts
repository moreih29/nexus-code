/**
 * Add-Workspace service group.
 *
 * Encapsulates all IPC calls for the Add Workspace dialog flow so that
 * components under `components/workspace/add-workspace/` do not import
 * `ipc/client` directly.
 */

// Folder bookmarks
export type { RecordLocalBookmarkArgs, RecordSshBookmarkArgs } from "./folder-bookmarks";
export {
  listFolderBookmarks,
  recordLocalBookmark,
  recordSshBookmark,
  setFolderBookmarkFavorite,
  removeFolderBookmark,
} from "./folder-bookmarks";

// Connection profiles
export type { SaveConnectionProfileArgs } from "./connection-profiles";
export {
  listConnectionProfiles,
  fetchConnectionProfiles,
  saveConnectionProfile,
  setConnectionProfileFavorite,
  removeConnectionProfile,
} from "./connection-profiles";

// Workspace creation + directory picker
export type { CreateSshWorkspaceArgs } from "./workspace-create";
export {
  createLocalWorkspace,
  pickLocalDirectory,
  createSshWorkspace,
  listSshConfigHosts,
} from "./workspace-create";

// SSH browse session
export type { OpenBrowseSessionArgs, BrowseSessionInfo, BrowseSessionResult } from "./ssh-browse";
export {
  openSshBrowseSession,
  browseSshSession,
  prefetchSshDirectory,
  closeSshBrowseSession,
} from "./ssh-browse";
