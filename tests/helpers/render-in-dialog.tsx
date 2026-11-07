/**
 * Server-renders a dialog's body inside its Radix root: the body's
 * DialogHeader is the dialog's Title and Description, which need the root's
 * context. No portal and no content node, so the markup is the body's own.
 */
import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from "radix-ui";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export function renderInDialog(body: ReactElement): string {
  return renderToStaticMarkup(<RadixDialog.Root open>{body}</RadixDialog.Root>);
}

export function renderInAlertDialog(body: ReactElement): string {
  return renderToStaticMarkup(<RadixAlertDialog.Root open>{body}</RadixAlertDialog.Root>);
}
