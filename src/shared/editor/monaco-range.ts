/**
 * Monaco-shaped range for use in renderer code that interacts with the Monaco
 * editor API. This mirrors `monaco.IRange` without importing the full Monaco
 * editor package from shared modules.
 *
 * Call sites: workspace-symbol-registry.ts, pending-reveal.ts.
 */
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
