import vm from "node:vm";

export const MATCH_BUDGET_MS = 100;

export class PatternTooSlowError extends Error {
  constructor() {
    super("the pattern took too long to match: give a simpler one");
  }
}

const context = vm.createContext({});
const findLine = new vm.Script("lines.find((line) => pattern.test(line))");

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
