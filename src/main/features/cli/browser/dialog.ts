/**
 * The JavaScript dialogs a driven page shows, and what the nexus CLI says
 * of them.
 */

import { withoutControls } from "./pick";

/**
 * A JavaScript dialog a page shows: an alert, a confirm, or a page asking
 * before it is left. A page's prompt() throws in Electron.
 */
export interface PageDialog {
  readonly type: string;
  readonly message: string;
  readonly url: string;
}

/** What a command says of the dialog a page shows, and how to answer it. */
export function dialogText(dialog: PageDialog): string {
  const what =
    dialog.type === "beforeunload"
      ? "asks before it is left"
      : `shows ${/^[aeiou]/.test(dialog.type) ? "an" : "a"} ${dialog.type} dialog: ${JSON.stringify(withoutControls(dialog.message))}`;
  return `The page ${what}. Answer it with nexus browser dialog accept, or dismiss.`;
}
