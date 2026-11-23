import { withoutControls } from "./pick";

export interface PageDialog {
  readonly type: string;
  readonly message: string;
  readonly url: string;
}

export function dialogText(dialog: PageDialog): string {
  const what =
    dialog.type === "beforeunload"
      ? "asks before it is left"
      : `shows ${/^[aeiou]/.test(dialog.type) ? "an" : "a"} ${dialog.type} dialog: ${JSON.stringify(withoutControls(dialog.message))}`;
  return `The page ${what}. Answer it with nexus browser dialog accept, or dismiss.`;
}
