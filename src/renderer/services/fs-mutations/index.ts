/**
 * Public surface of the fs-mutations service group.
 *
 * Each operation is one file (reveal here; rename/delete/new-file
 * arriving in later steps). Callers import from this barrel so future
 * file moves stay invisible.
 */

export type { NewFileInput } from "./new-file";
export { createNewFile } from "./new-file";
export type { NewFolderInput } from "./new-folder";
export { createNewFolder } from "./new-folder";
export type { RevealInput } from "./reveal";
export { revealInFinder } from "./reveal";
