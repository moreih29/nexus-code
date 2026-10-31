/**
 * bufferText — a terminal's buffer as the plain text `nexus terminal read`
 * prints.
 */
import { expect, test } from "bun:test";
import { bufferText } from "../../../../src/renderer/services/terminal/controller";

function buffer(lines: Array<[text: string, wrapped?: boolean]>) {
  return {
    type: "normal" as const,
    length: lines.length,
    getLine: (y: number) => {
      const line = lines[y];
      return line ? { isWrapped: line[1] === true, translateToString: () => line[0] } : undefined;
    },
  };
}

test("wrapped lines are joined back and the blank rows below the output left out", () => {
  const text = bufferText(
    buffer([["$ echo a very long"], [" line", true], ["a very long line"], ["$ "], [""], [""]]),
    10,
  );
  expect(text).toBe("$ echo a very long line\na very long line\n$ ");
});

test("only the last lines asked for", () => {
  expect(bufferText(buffer([["1"], ["2"], ["3"]]), 2)).toBe("2\n3");
});
