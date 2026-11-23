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
