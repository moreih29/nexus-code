import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";
import { DialogCloseButton } from "./dialog-close-button";

export function DialogHeader({
  title,
  description,
  descriptionClassName,
  leading,
  actions,
  close = false,
  alert = false,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  close?: boolean;
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
          <Description className={cn("text-app-ui-sm text-muted-foreground", descriptionClassName)}>
            {description}
          </Description>
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
