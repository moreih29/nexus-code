import type { RpcParams, RpcResult } from "../../../../../packages/remote-protocol/src";
import type { CliUiOps } from "../../../../shared/cli/ui";
import type { CliServices } from "../../cli/context";
import { fitsAsResult, tabOf, unavailable } from "./common";
import { ReadBudget } from "./read-budget";

export const DEFAULT_TERMINAL_LINES = 1000;

export async function readTerminal(
  services: CliServices,
  { workspaceId, tabId, lines, ansi }: RpcParams<"terminal.read">,
  from?: string,
): Promise<RpcResult<"terminal.read">> {
  const budget = new ReadBudget(services, "terminal.read", from, 12_000);
  try {
    await tabOf(services, workspaceId, tabId, ["terminal"], budget);
    const screen = await budget
      .ui(
        "terminal.read",
        { workspaceId, tabId, lines: lines ?? DEFAULT_TERMINAL_LINES, ...(ansi ? { ansi } : {}) },
        budget.remaining(),
      )
      .catch(unavailable);
    return fitScreen(screen);
  } finally {
    budget.report();
  }
}

function fitScreen({ text, caret }: CliUiOps["terminal.read"]["result"]) {
  let shown = text;
  let line = caret?.line;
  while (!fitsAsResult({ text: shown, caret })) {
    const cut = shown.slice(Math.floor(shown.length / 4));
    const at = cut.indexOf("\n");
    const kept = at >= 0 ? cut.slice(at + 1) : cut;
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
