import { describe, expect, it } from "bun:test";
import {
  NotebookError,
  notebookToMarkdown,
  terminalText,
} from "../../../../../../src/renderer/services/editor/preview/notebook";

const ESC = String.fromCharCode(0x1b);

function notebook(cells: unknown[], metadata: unknown = {}): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });
}

function reason(source: string): string {
  try {
    notebookToMarkdown(source);
  } catch (error) {
    if (error instanceof NotebookError) return error.reason;
    throw error;
  }
  return "read";
}

describe("terminalText", () => {
  it("drops colour codes and keeps a redrawn line's last state", () => {
    expect(terminalText(`${ESC}[0;31mValueError${ESC}[0m: bad`)).toBe("ValueError: bad");
    expect(terminalText(`${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(terminalText(" 10%\r 50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });
});

describe("notebookToMarkdown", () => {
  it("puts markdown cells in as they are, and code under its prompt in the notebook's language", () => {
    const { markdown } = notebookToMarkdown(
      notebook(
        [
          { cell_type: "markdown", metadata: {}, source: ["# Title\n", "Some *text*"] },
          { cell_type: "code", execution_count: 3, metadata: {}, outputs: [], source: "x = 1" },
          { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "y" },
        ],
        { language_info: { name: "R" } },
      ),
    );
    expect(markdown).toBe(
      [
        "# Title\nSome *text*",
        "<sub>In&nbsp;[3]:</sub>\n\n```r\nx = 1\n```",
        "<sub>In&nbsp;[&nbsp;]:</sub>\n\n```r\ny\n```",
      ].join("\n\n"),
    );
  });

  it("falls back to the kernel's language, then python, and skips empty cells", () => {
    const cells = [
      { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "" },
      { cell_type: "code", execution_count: 1, metadata: {}, outputs: [], source: "1" },
    ];
    expect(
      notebookToMarkdown(notebook(cells, { kernelspec: { language: "julia" } })).markdown,
    ).toBe("<sub>In&nbsp;[1]:</sub>\n\n```julia\n1\n```");
    expect(notebookToMarkdown(notebook(cells)).markdown).toContain("```python\n1\n```");
  });

  it("fences a block longer than the backticks in it", () => {
    const { markdown } = notebookToMarkdown(
      notebook([{ cell_type: "raw", metadata: {}, source: "a ```` b" }]),
    );
    expect(markdown).toBe("`````\na ```` b\n`````");
  });

  it("shows streams, errors and results", () => {
    const { markdown } = notebookToMarkdown(
      notebook([
        {
          cell_type: "code",
          execution_count: 2,
          metadata: {},
          source: "run()",
          outputs: [
            { output_type: "stream", name: "stdout", text: ["0%\r", "100%\n"] },
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "bad",
              traceback: [`${ESC}[0;31mValueError${ESC}[0m: bad`, "  line 1"],
            },
            {
              output_type: "execute_result",
              execution_count: 2,
              metadata: {},
              data: { "text/plain": ["42"] },
            },
            { output_type: "display_data", metadata: {}, data: { "application/json": { a: [1] } } },
            { output_type: "display_data", metadata: {}, data: { "text/markdown": "**bold**" } },
          ],
        },
      ]),
    );
    expect(markdown.split("\n\n").slice(2)).toEqual([
      "```\n100%\n```",
      "```\nValueError: bad\n  line 1\n```",
      "<sub>Out&nbsp;[2]:</sub>",
      "```\n42\n```",
      '```json\n{\n  "a": [\n    1\n  ]\n}\n```',
      "**bold**",
    ]);
  });

  it("names images by placeholders, and keeps HTML as one block without its styles", () => {
    const { markdown, images } = notebookToMarkdown(
      notebook([
        {
          cell_type: "markdown",
          metadata: {},
          source: "![chart](attachment:a.png)",
          attachments: { "a.png": { "image/png": "QUJD\n" } },
        },
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          source: "df",
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: { "image/png": "iVBO\nRw0K", "text/plain": "<Figure>" },
            },
            {
              output_type: "execute_result",
              execution_count: 1,
              metadata: {},
              data: {
                "text/html":
                  "<div>\n<style scoped>td { color: red }</style>\n<table>\n\n  <tr><td>1</td></tr>\n</table>\n</div>",
                "text/plain": "   a\n0  1",
              },
            },
            {
              output_type: "display_data",
              metadata: {},
              data: { "image/svg+xml": "<svg/>" },
            },
          ],
        },
      ]),
    );
    expect(markdown).toContain("![chart](#nb-image-0)");
    expect(markdown).toContain("![](#nb-image-1)");
    expect(markdown).toContain(
      "<div>\n<div>\n<table>\n  <tr><td>1</td></tr>\n</table>\n</div>\n</div>",
    );
    expect(markdown).toContain("![](#nb-image-2)");
    expect(images).toEqual(
      new Map([
        ["#nb-image-0", "data:image/png;base64,QUJD"],
        ["#nb-image-1", "data:image/png;base64,iVBORw0K"],
        ["#nb-image-2", "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E"],
      ]),
    );
  });

  it("shows a scripted chart's picture rather than its HTML", () => {
    const { markdown } = notebookToMarkdown(
      notebook([
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          source: "fig",
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: { "text/html": "<div id=c></div><script>draw()</script>", "image/png": "AA==" },
            },
          ],
        },
      ]),
    );
    expect(markdown).toContain("![](#nb-image-0)");
    expect(markdown).not.toContain("script");
  });

  it("refuses what is not a notebook", () => {
    expect(reason("{")).toBe("not_json");
    expect(reason('{"worksheets": []}')).toBe("unsupported");
    expect(reason("[]")).toBe("unsupported");
  });
});
