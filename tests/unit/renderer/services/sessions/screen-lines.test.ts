/**
 * A terminal screen's lines as the sessions tab's detail panel draws them,
 * told by their shape.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyLine,
  screenLines,
} from "../../../../../src/renderer/services/sessions/screen-lines";

describe("classifyLine", () => {
  it("tells a Claude Code screen's lines by their shape", () => {
    expect(classifyLine("⏺ Bash(bun run test)")).toBe("item");
    expect(classifyLine("● I read the file.")).toBe("item");
    expect(classifyLine("  ⎿  4013 pass")).toBe("result");
    expect(classifyLine("      12 +  const a = 1;")).toBe("added");
    expect(classifyLine("      12 -  const a = 0;")).toBe("removed");
    expect(classifyLine("✻ Simmering… (12s · esc to interrupt)")).toBe("status");
    expect(classifyLine("· Thinking...")).toBe("status");
    expect(classifyLine("────────────────────────────────")).toBe("rule");
    expect(classifyLine("> fix the build")).toBe("prompt");
    expect(classifyLine("│ > ")).toBe("prompt");
    expect(classifyLine("› run the tests")).toBe("prompt");
    expect(classifyLine("  ⏵⏵ accept edits on (shift+tab to cycle)")).toBe("hint");
    expect(classifyLine("  ? for shortcuts")).toBe("hint");
    expect(classifyLine("   ")).toBe("blank");
    expect(classifyLine("Plain words the agent wrote.")).toBe("text");
  });

  it("leaves a short dash run and a bare asterisk as text", () => {
    expect(classifyLine("--- a/file")).toBe("text");
    expect(classifyLine("* a list item")).toBe("text");
  });
});

describe("screenLines", () => {
  it("keeps runs of blank lines to one and drops them at the ends", () => {
    const lines = screenLines("\n\n⏺ Read(a.ts)\n\n\n  ⎿  Read 10 lines   \n\n");
    expect(lines).toEqual([
      { kind: "item", text: "⏺ Read(a.ts)" },
      { kind: "blank", text: "" },
      { kind: "result", text: "  ⎿  Read 10 lines" },
    ]);
  });

  it("returns nothing for an empty screen", () => {
    expect(screenLines("")).toEqual([]);
    expect(screenLines("\n  \n")).toEqual([]);
  });
});
