/**
 * Inline editable row used by the file tree when a "New File",
 * "New Folder", or "Rename" gesture is in progress.
 *
 * UX:
 *   - Auto-focuses on mount. A file rename selects the name without its
 *     extension, so typing replaces just that (VSCode parity).
 *   - Enter → commit, Escape → cancel.
 *   - Blur → commit if non-empty, cancel if empty (matches VSCode).
 *   - Inline validation message under the input when name is invalid;
 *     commit is disabled while invalid.
 *   - Visually mimics FileTreeRow (same height + indent) so the layout
 *     doesn't jump when the row swaps in.
 *
 * The row is *not* draggable (it's transient and ownerless).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { isImeComposing } from "@/utils/ime";
import { validateNewEntryName } from "../name-validator";
import type { EntryKind } from "./display";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "./metrics";

interface FileTreeEditRowProps {
  kind: EntryKind;
  depth: number;
  initialValue?: string;
  /** Whether the entry is on a Windows file system, whose naming rules apply. */
  windows?: boolean;
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * End of the initial selection when renaming `name`: up to its last dot for a
 * file, the whole name for a folder or a file whose only dot leads it.
 */
export function renameSelectionEnd(name: string, kind: EntryKind): number {
  if (kind !== "file") return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

// The caller (file-tree) routes New-File / New-Folder through
// useContextMenuHandoff so the row is mounted only after Radix's
// FocusScope releases. Without that handoff Radix would return focus to
// the menu trigger after close and immediately blur the input below,
// firing onBlur on an empty value and unmounting the row before the
// user can type.
export function FileTreeEditRow({
  kind,
  depth,
  initialValue = "",
  windows = false,
  onCommit,
  onCancel,
}: FileTreeEditRowProps) {
  const { t } = useTranslation("files");
  const [value, setValue] = useState(initialValue);
  const validationError = value.length > 0 ? validateNewEntryName(value, t, { windows }) : null;
  const canCommit = value.trim().length > 0 && validationError === null;
  // The row stays mounted until the create/rename IPC resolves. A second
  // Enter, or the blur that follows the first one, must not submit again:
  // the duplicate fails with "already exists" after the first succeeded.
  const committingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mount-only: the selection is set once, for the name the row opened with.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on mount only
  useEffect(() => {
    if (!initialValue) return;
    inputRef.current?.setSelectionRange(0, renameSelectionEnd(initialValue, kind));
  }, []);

  function commit() {
    if (committingRef.current) return;
    committingRef.current = true;
    void Promise.resolve(onCommit(value)).finally(() => {
      committingRef.current = false;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (!canCommit) return;
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function handleBlur() {
    if (committingRef.current) return;
    // Empty input → cancel; non-empty + invalid → cancel (don't trap user).
    if (!canCommit) {
      onCancel();
      return;
    }
    commit();
  }

  return (
    <div
      className="flex items-center"
      style={{ height: ROW_HEIGHT_PX, paddingLeft: indentPaddingLeft(depth) }}
    >
      {/* Same 14px chevron slot reserved as a regular row, kept blank. */}
      <span className="size-3.5 shrink-0" aria-hidden />
      <div className="relative ml-1 flex-1 min-w-0">
        <input
          // biome-ignore lint/a11y/noAutofocus: inline-create row should grab focus on mount; cancellable via Esc/blur
          autoFocus
          ref={inputRef}
          aria-label={
            initialValue
              ? kind === "file"
                ? t("fileTree.editRow.renameFile")
                : t("fileTree.editRow.renameFolder")
              : kind === "file"
                ? t("fileTree.editRow.newFileName")
                : t("fileTree.editRow.newFolderName")
          }
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={cn(
            "w-full text-app-body bg-input/50 outline-none",
            "border border-border rounded-(--radius-control) px-1 h-5",
            validationError && "border-destructive",
          )}
        />
        {/* The virtual list gives every row the same height, so the message
            floats over the rows below instead of pushing them down. */}
        {validationError ? (
          <span
            className={cn(
              "absolute top-full left-0 right-0 mt-0.5 px-1 py-0.5",
              "text-app-micro text-destructive bg-popover",
              "border border-destructive rounded-(--radius-control)",
            )}
          >
            {validationError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
