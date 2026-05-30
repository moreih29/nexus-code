/**
 * Minimal ambient types for the deep monaco import used by `compute.ts`.
 *
 * The `monaco-editor` package ships no `.d.ts` files under its `esm/` tree, so
 * the internal diff computer has no types of its own. We declare only the slice
 * of its surface we consume — `linesDiffComputers.getDefault().computeDiff(...)`
 * and the `LineRange` / `DetailedLineRangeMapping` shapes it returns.
 */
declare module "monaco-editor/esm/vs/editor/common/diff/linesDiffComputers" {
  interface ILineRange {
    readonly startLineNumber: number;
    readonly endLineNumberExclusive: number;
    readonly isEmpty: boolean;
  }

  interface IDetailedLineRangeMapping {
    readonly original: ILineRange;
    readonly modified: ILineRange;
  }

  interface ILinesDiff {
    readonly changes: readonly IDetailedLineRangeMapping[];
    readonly hitTimeout: boolean;
  }

  interface ILinesDiffComputerOptions {
    readonly computeMoves: boolean;
    readonly ignoreTrimWhitespace: boolean;
    readonly maxComputationTimeMs: number;
  }

  interface ILinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: ILinesDiffComputerOptions,
    ): ILinesDiff;
  }

  export const linesDiffComputers: {
    getLegacy(): ILinesDiffComputer;
    getDefault(): ILinesDiffComputer;
  };
}
