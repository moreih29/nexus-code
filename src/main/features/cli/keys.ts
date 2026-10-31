/** Key names for `nexus terminal key`, and the bytes a terminal sends for them. */
import { CliUsageError } from "./args";

const NAMED: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  esc: "\x1b",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
};

export const KEY_NAMES_HELP =
  "Keys: enter, tab, shift-tab, esc, space, backspace, delete, up, down, left, right, home,\n" +
  "end, pageup, pagedown, ctrl-<letter> (ctrl-c, ctrl-d, ...), or any single character.";

/** What a terminal sends for the key `name`. */
export function keySequence(name: string): string {
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named !== undefined) return named;
  const ctrl = /^ctrl[-+]([a-z])$/.exec(lower);
  if (ctrl) return String.fromCharCode((ctrl[1] as string).charCodeAt(0) - 96);
  if ([...name].length === 1) return name;
  throw new CliUsageError(`unknown key "${name}". ${KEY_NAMES_HELP.replace("\n", " ")}`);
}
