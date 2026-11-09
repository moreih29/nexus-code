/**
 * An agent's Markdown answer in short: plain words in a list's row, one
 * line of Markdown in the detail when its line breaks are gone.
 */
import { describe, expect, it } from "bun:test";
import {
  oneLineMarkdown,
  plainPreview,
} from "../../../../../src/renderer/services/sessions/preview";

describe("plainPreview", () => {
  it("drops headings, list marks, bold and code", () => {
    const answer = [
      "### Fruits",
      "",
      "- 사과",
      "- **바나나**",
      "1. 체리",
      "",
      "Use `pick()` to choose.",
    ].join("\n");
    expect(plainPreview(answer)).toBe("Fruits 사과 바나나 체리 Use pick() to choose.");
  });

  it("keeps a code block's code, without its fences", () => {
    expect(plainPreview("Done:\n```ts\nconst a = 1;\n```")).toBe("Done: const a = 1;");
  });

  it("reads a link as its words and an image as its words or its file", () => {
    expect(plainPreview("See [the guide](docs/guide.md).")).toBe("See the guide.");
    expect(plainPreview("Here: ![green](ql/green.png)")).toBe("Here: green");
    expect(plainPreview("Here: ![](shots/after.png)")).toBe("Here: after.png");
  });

  it("drops quote marks and strikes", () => {
    expect(plainPreview("> note\n~~old~~ new")).toBe("note old new");
  });

  it("leaves what only looks like Markdown", () => {
    expect(plainPreview("C# and issue #12, a - b, snake_case and __init__")).toBe(
      "C# and issue #12, a - b, snake_case and __init__",
    );
    expect(plainPreview("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("reads an answer told on one line", () => {
    expect(plainPreview("### Fruits - 사과 - **바나나** ```ts const a = 1; ```")).toBe(
      "Fruits - 사과 - 바나나 const a = 1;",
    );
  });
});

describe("oneLineMarkdown", () => {
  it("takes out what would take the whole line, and the fences", () => {
    expect(oneLineMarkdown("### Fruits - 사과 - **바나나** ```ts const a = 1; ```")).toBe(
      "Fruits - 사과 - **바나나** const a = 1;",
    );
    expect(oneLineMarkdown("- first - second")).toBe("first - second");
    expect(oneLineMarkdown("> quoted words")).toBe("quoted words");
    expect(oneLineMarkdown("1. one 2. two")).toBe("one 2. two");
  });

  it("keeps bold, code, links and images", () => {
    const line = "**Done**: see `a.ts` and [docs](docs.md) ![green](ql/green.png)";
    expect(oneLineMarkdown(line)).toBe(line);
  });
});
