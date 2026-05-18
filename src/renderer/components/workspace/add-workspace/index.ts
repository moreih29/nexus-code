// Public surface for add-workspace modal split-file structure.
export { AddWorkspaceDialog } from "./add-workspace-dialog";
export type { AddWorkspaceDialogProps } from "./add-workspace-dialog";
// Pure SSH utility exports (used by tests)
export {
  filterSshConfigHosts,
  findSshConfigHost,
  parseSshDestination,
  parseSshPort,
} from "./ssh-helpers";
// Type exports for downstream tasks (T3, T4)
export type {
  MainListViewProps,
  ModalView,
  SshBrowseSession,
  SshConnectionListViewProps,
  SshDirectoryPickerViewProps,
  SshNewConnectionViewProps,
} from "./types";
