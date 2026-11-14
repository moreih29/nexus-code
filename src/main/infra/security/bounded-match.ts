/**
 * Patterns an agent or another device gives (nexus terminal wait --match,
 * terminal.wait's match, nexus browser wait --url) run in the main
 * process, where one that backtracks without end, as `( +)+$` on a run of
 * spaces, would hold up the whole app. They are tested here, in a context
 * of their own with a time limit: past it, the test stops with
 * PatternTooSlowError instead.
 */
import vm from "node:vm";

/** How long one look for a pattern may take. */
export const MATCH_BUDGET_MS = 100;

export class PatternTooSlowError extends Error {
  constructor() {
    super("the pattern took too long to match: give a simpler one");
  }
}

const context = vm.createContext({});
const findLine = new vm.Script("lines.find((line) => pattern.test(line))");

/** The first of `lines` the pattern matches; PatternTooSlowError past the budget. */
export function firstMatch(
  pattern: RegExp,
  lines: readonly string[],
  budgetMs = MATCH_BUDGET_MS,
): string | undefined {
  context.pattern = pattern;
  context.lines = lines;
  try {
    return findLine.runInContext(context, { timeout: budgetMs }) as string | undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new PatternTooSlowError();
    }
    throw error;
  } finally {
    context.pattern = undefined;
    context.lines = undefined;
  }
}
