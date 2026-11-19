import type { RpcParams, RpcResult } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../cli/context";
import { fitsAsResult, tabOf, unavailable } from "./common";

/** How many lines of a terminal a read gives when it does not say. */
export const DEFAULT_TERMINAL_LINES = 1000;

export async function readTerminal(
  services: CliServices,
  { workspaceId, tabId, lines, ansi }: RpcParams<"terminal.read">,
): Promise<RpcResult<"terminal.read">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const { text, caret } = await services
    .ui("terminal.read", {
      workspaceId,
      tabId,
      lines: lines ?? DEFAULT_TERMINAL_LINES,
      ...(ansi ? { ansi } : {}),
    })
    .catch(unavailable);
  // The end of it, as much as goes in a frame, from a line's start: no escape cut in two. The
  // cursor goes up with the lines cut; above them, it is not told.
  let shown = text;
  let line = caret?.line;
  while (!fitsAsResult({ text: shown, caret })) {
    const cut = shown.slice(Math.floor(shown.length / 4));
    const at = cut.indexOf("\n");
    const kept = at >= 0 ? cut.slice(at + 1) : cut;
    // Lines cut whole take the cursor up with them; one cut in two loses it.
    if (line !== undefined) {
      line =
        at >= 0 ? line - (shown.slice(0, shown.length - kept.length).split("\n").length - 1) : -1;
    }
    shown = kept;
  }
  return caret && line !== undefined && line >= 0
    ? { text: shown, caret: { line, column: caret.column } }
    : { text: shown };
}
