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
  windows?: boolean;
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}

export function renameSelectionEnd(name: string, kind: EntryKind): number {
  if (kind !== "file") return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

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
  const committingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
