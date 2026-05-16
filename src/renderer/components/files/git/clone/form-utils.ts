/**
 * Pure helpers behind the Clone dialog: form-field definitions, URL/path
 * validators, filesystem-path preview, and the phase-label lookup. None of
 * these touch React or IPC — they are the testable seam between the dialog
 * component and the validation/preview rules.
 *
 * The folder-name pattern intentionally mirrors what the main-process clone
 * runner enforces so the dialog rejects bad names before the IPC round-trip.
 */

import type { GitClonePhase, GitStatus } from "../../../../../shared/git/types";
import type { FormDialogField } from "../../../ui/form-dialog";

export const CLONE_FOLDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Derives a folder name preview from common Git URL syntaxes. */
export function deriveFolderNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const pivot = Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf(":"));
  const rawName = pivot >= 0 ? withoutQuery.slice(pivot + 1) : withoutQuery;
  return rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
}

/** Returns the live filesystem preview for the clone destination. */
export function previewClonePath(parent: string, name: string): string {
  if (!parent.trim() || !name.trim()) return "";
  return joinFsPath(parent.trim(), name.trim());
}

/** Validates a clone URL using intentionally relaxed Git-compatible rules. */
export function validateCloneUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Repository URL is required";
  if (/\s/.test(trimmed)) return "Repository URL cannot contain spaces";
  return null;
}

/** Validates that the parent folder is an absolute path string. */
export function validateCloneParent(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Choose a parent folder";
  if (!isLikelyAbsolutePath(trimmed)) return "Choose an absolute parent folder";
  return null;
}

/** Validates the folder name rule enforced by the main-process clone runner. */
export function validateCloneFolderName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Folder name is required";
  if (trimmed.length > 255) return "Folder name is too long";
  if (trimmed.startsWith(".")) return "Folder name cannot start with a dot";
  if (!CLONE_FOLDER_NAME_PATTERN.test(trimmed)) {
    return "Use letters, numbers, dot, underscore, or dash";
  }
  return null;
}

/** Returns a parent directory for POSIX and Windows-style absolute paths. */
export function parentDirectoryOf(absPath: string): string {
  const trimmed = absPath.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash <= 0) return "";
  if (/^[A-Za-z]:/.test(trimmed) && slash <= 2) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.slice(0, slash);
}

/** Joins a parent path and child name using the parent's apparent separator. */
export function joinFsPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  if (trimmed.length === 0 && parent.startsWith("/")) return `/${name}`;
  return `${trimmed}${sep}${name}`;
}

/** Checks the path syntaxes the renderer can recognize without Node path. */
function isLikelyAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Creates the four FormDialog fields used by the clone form. */
export function createCloneFormFields(): FormDialogField[] {
  return [
    {
      name: "url",
      label: "Repository URL",
      type: "text",
      placeholder: "https://github.com/org/repo.git",
      autoFocus: true,
      inputClassName: "font-mono",
      validate: validateCloneUrl,
    },
    {
      name: "parent",
      label: "Parent folder",
      placeholder: "/Users/alice/work",
      readOnly: true,
      validate: validateCloneParent,
    },
    {
      name: "name",
      label: "Folder name",
      placeholder: "repo",
      validate: validateCloneFolderName,
    },
    {
      name: "branch",
      label: "Branch",
      placeholder: "default branch",
      required: false,
    },
  ];
}

/** Converts a clone phase into the status line shown under the title. */
export function clonePhaseLabel(phase: GitClonePhase | null): string {
  switch (phase) {
    case "counting":
      return "Counting objects…";
    case "compressing":
      return "Compressing objects…";
    case "receiving":
      return "Receiving objects…";
    case "resolving":
      return "Resolving deltas…";
    case "checkout":
      return "Checking out files…";
    default:
      return "Preparing clone…";
  }
}

/** Returns true when the active source-control session has local changes. */
export function isGitSessionDirty(status: GitStatus | null): boolean {
  if (!status) return false;
  return (
    status.merge.length + status.staged.length + status.working.length + status.untracked.length > 0
  );
}
