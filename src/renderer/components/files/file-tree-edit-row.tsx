/**
 * Inline editable row used by the file tree when a "New File" /
 * "New Folder" gesture is in progress.
 *
 * UX:
 *   - Auto-focuses on mount.
 *   - Enter → commit, Escape → cancel.
 *   - Blur → commit if non-empty, cancel if empty (matches VSCode).
 *   - Inline validation message under the input when name is invalid;
 *     commit is disabled while invalid.
 *   - Visually mimics FileTreeRow (same height + indent) so the layout
 *     doesn't jump when the row swaps in.
 *
 * The row is *not* draggable (it's transient and ownerless).
 */

import { useState } from "react";
import { cn } from "@/utils/cn";
import type { EntryKind } from "./file-tree-display";
import { indentPaddingLeft, ROW_HEIGHT_PX } from "./file-tree-metrics";
import { validateNewEntryName } from "./name-validator";

interface FileTreeEditRowProps {
  kind: EntryKind;
  depth: number;
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}

// The caller (file-tree) routes New-File / New-Folder through
// useContextMenuHandoff so the row is mounted only after Radix's
// FocusScope releases. Without that handoff Radix would return focus to
// the menu trigger after close and immediately blur the input below,
// firing onBlur on an empty value and unmounting the row before the
// user can type.
export function FileTreeEditRow({ kind, depth, onCommit, onCancel }: FileTreeEditRowProps) {
  const [value, setValue] = useState("");
  const validationError = value.length > 0 ? validateNewEntryName(value) : null;
  const canCommit = value.trim().length > 0 && validationError === null;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!canCommit) return;
      void onCommit(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function handleBlur() {
    // Empty input → cancel; non-empty + invalid → cancel (don't trap user).
    if (!canCommit) {
      onCancel();
      return;
    }
    void onCommit(value);
  }

  return (
    <div className="flex flex-col" style={{ paddingLeft: indentPaddingLeft(depth) }}>
      <div className="flex items-center" style={{ height: ROW_HEIGHT_PX }}>
        {/* Same 14px chevron slot reserved as a regular row, kept blank. */}
        <span className="size-3.5 shrink-0" aria-hidden />
        <input
          // biome-ignore lint/a11y/noAutofocus: inline-create row should grab focus on mount; cancellable via Esc/blur
          autoFocus
          aria-label={kind === "file" ? "New file name" : "New folder name"}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={cn(
            "ml-1 flex-1 min-w-0 text-app-body bg-input/50 outline-none",
            "border border-mist-border rounded-[2px] px-1 h-5",
            validationError && "border-destructive",
          )}
        />
      </div>
      {validationError ? (
        <span className="text-micro text-destructive ml-5 mt-0.5">{validationError}</span>
      ) : null}
    </div>
  );
}
