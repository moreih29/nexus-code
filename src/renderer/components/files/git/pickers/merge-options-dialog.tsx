/**
 * MergeOptionsDialog asks how the selected target should be merged.
 *
 * The dialog owns only renderer choice state. Git execution remains in the
 * panel/store path, and the selected radio maps to the existing GitMergeMode
 * IPC enum at submit time.
 */
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import type { GitMergeMode, LogEntry } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { Dialog } from "../../../ui/dialog";

export type MergeOption = "merge-commit" | "fast-forward" | "squash";

export interface MergeOptionsRequest {
  targetRef: string;
}

interface MergeOptionsDialogProps {
  request: MergeOptionsRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (option: MergeOption, mode: GitMergeMode) => void;
}

interface MergeOptionsDialogContentProps {
  targetRef: string;
  option: MergeOption;
  busy?: boolean;
  onOptionChange: (option: MergeOption) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

function getMergeOptions(): readonly {
  option: MergeOption;
  label: string;
  description: string;
}[] {
  const t = i18next.t.bind(i18next);
  return [
    {
      option: "merge-commit",
      label: t("files:git.merge.options.mergeCommit"),
      description: t("files:git.merge.options.mergeCommitDescription"),
    },
    {
      option: "fast-forward",
      label: t("files:git.merge.options.fastForward"),
      description: t("files:git.merge.options.fastForwardDescription"),
    },
    {
      option: "squash",
      label: t("files:git.merge.options.squash"),
      description: t("files:git.merge.options.squashDescription"),
    },
  ];
}

/** Maps renderer wording to the backend GitMergeMode enum. */
export function mergeModeFromOption(option: MergeOption): GitMergeMode {
  switch (option) {
    case "merge-commit":
      return "no-ff";
    case "fast-forward":
      return "default";
    case "squash":
      return "squash";
  }
}

/** Returns the CTA label for the current merge option. */
export function mergeOptionsSubmitLabel(option: MergeOption): string {
  const t = i18next.t.bind(i18next);
  return option === "squash" ? t("files:git.merge.submitSquash") : t("files:git.merge.submitMerge");
}

/**
 * Builds the commit draft inserted after a successful squash merge. Subjects
 * are intentionally capped so a long branch does not flood the commit box.
 */
export function buildSquashCommitDraft(targetRef: string, commits: readonly LogEntry[]): string {
  const subjectLines = commits
    .map((commit) => commit.subject.trim())
    .filter((subject) => subject.length > 0)
    .slice(0, 10)
    .map((subject) => `* ${subject}`);

  const body = subjectLines.length > 0 ? ["", ...subjectLines] : [];
  return [`Squash merge of '${targetRef}'`, ...body].join("\n").trimEnd();
}

/** Renders the dialog body without the Radix portal for static tests. */
export function MergeOptionsDialogContent({
  targetRef,
  option,
  busy = false,
  onOptionChange,
  onCancel,
  onSubmit,
}: MergeOptionsDialogContentProps): React.JSX.Element {
  const { t } = useTranslation("files");
  const MERGE_OPTIONS = getMergeOptions();
  return (
    <>
      <div className="text-app-body-emphasis text-foreground" aria-hidden="true">
        {t("git.merge.title", { ref: targetRef })}
      </div>
      <div className="mt-2 text-app-ui-sm text-muted-foreground" aria-hidden="true">
        {t("git.merge.chooseMerge", { ref: targetRef })}
      </div>
      <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">{t("git.merge.strategyLegend")}</legend>
          {MERGE_OPTIONS.map((item) => {
            const inputId = `merge-option-${item.option}`;
            return (
              <label
                key={item.option}
                htmlFor={inputId}
                className="flex cursor-pointer items-start gap-3 rounded-(--radius-raised) border border-border bg-muted px-3 py-2 text-app-ui-sm"
              >
                <input
                  id={inputId}
                  type="radio"
                  name="merge-option"
                  value={item.option}
                  checked={option === item.option}
                  disabled={busy}
                  onChange={() => onOptionChange(item.option)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block text-foreground">{item.label}</span>
                  <span className="block text-muted-foreground">{item.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {option === "squash" ? (
          <p className="rounded-(--radius-raised) border border-border bg-muted px-3 py-2 text-app-ui-sm text-muted-foreground">
            {t("git.merge.squashNote")}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t("git.merge.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {mergeOptionsSubmitLabel(option)}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Mounts merge option radios inside the standard modal shell. */
export function MergeOptionsDialog({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: MergeOptionsDialogProps): React.JSX.Element {
  const [option, setOption] = useState<MergeOption>("merge-commit");

  useEffect(() => {
    if (request) setOption("merge-commit");
  }, [request]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!request || busy) return;
    onConfirm(option, mergeModeFromOption(option));
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      size="md"
    >
      <RadixDialog.Title className="sr-only">
        {request ? i18next.t("files:git.merge.title", { ref: request.targetRef }) : i18next.t("files:git.merge.srTitle")}
      </RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        {request
          ? i18next.t("files:git.merge.chooseMerge", { ref: request.targetRef })
          : i18next.t("files:git.merge.chooseStrategy")}
      </RadixDialog.Description>
      {request ? (
        <MergeOptionsDialogContent
          targetRef={request.targetRef}
          option={option}
          busy={busy}
          onOptionChange={setOption}
          onCancel={onCancel}
          onSubmit={handleSubmit}
        />
      ) : null}
    </Dialog>
  );
}
