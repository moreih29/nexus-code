/**
 * DialogHeader — the top of a dialog: its title, what it is for under it,
 * and on the right whatever acts on the whole dialog, then the × for a
 * dialog that has no Cancel button. One look for every dialog.
 *
 * The title and description are Radix's, so they also name and describe the
 * dialog to a screen reader: a dialog shows this one header rather than a
 * hidden title beside a visible copy. An AlertDialog's are its own
 * primitives (`alert`).
 */

import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";
import { DialogCloseButton } from "./dialog-close-button";

export function DialogHeader({
  title,
  description,
  leading,
  actions,
  close = false,
  alert = false,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Before the title: the back button of a dialog with views. */
  leading?: ReactNode;
  /** After the title, before the ×: buttons that act on the whole dialog. */
  actions?: ReactNode;
  /** The × at the right, for a dialog with no Cancel button. */
  close?: boolean;
  /** For an AlertDialog. */
  alert?: boolean;
  className?: string;
}) {
  const Title = alert ? RadixAlertDialog.Title : RadixDialog.Title;
  const Description = alert ? RadixAlertDialog.Description : RadixDialog.Description;
  return (
    <div className={cn("flex items-start gap-2", className)}>
      {leading ? <div className="-mt-1 flex shrink-0 items-center">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Title className="break-words text-app-body-emphasis text-foreground">{title}</Title>
        {description ? (
          <Description className="text-app-ui-sm text-muted-foreground">{description}</Description>
        ) : null}
      </div>
      {actions || close ? (
        <div className="-mt-1 flex shrink-0 items-center gap-1">
          {actions}
          {close ? <DialogCloseButton /> : null}
        </div>
      ) : null}
    </div>
  );
}
