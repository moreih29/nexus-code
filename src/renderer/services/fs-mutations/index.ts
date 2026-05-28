/**
 * Public surface of the fs-mutations service group.
 *
 * Each operation is one file (reveal here; rename/delete/new-file
 * arriving in later steps). Callers import from this barrel so future
 * file moves stay invisible.
 */

export { confirmAndDeleteBatch, confirmAndDeletePath } from "./confirm-delete";
export type { CopyFileInput } from "./copy-file";
export { copyPathWithAutoRename } from "./copy-file";
export { distinctParents } from "./distinct-parents";
export { incrementFileName } from "./increment-name";
export type { NewFileInput } from "./new-file";
export { createNewFile } from "./new-file";
export type { NewFolderInput } from "./new-folder";
export { createNewFolder } from "./new-folder";
export type { PathActionContext, PathActions } from "./path-actions";
export { createPathActions } from "./path-actions";
export type { RemoveDirInput } from "./remove-dir";
export { removeDir } from "./remove-dir";
export type { MoveInput, RenameInput } from "./rename";
export { movePath, renamePath } from "./rename";
export type { RevealInput } from "./reveal";
export { revealInFinder } from "./reveal";
export type { RmdirInput } from "./rmdir";
export { rmdirPath } from "./rmdir";
export type { TrashPathInput } from "./trash";
export { trashPath } from "./trash";
export type { UnlinkInput } from "./unlink";
export { unlinkPath } from "./unlink";
