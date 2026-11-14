/** The mic while a dictation runs: the pill that shows it listening and finishes it. */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { VoicePill, clockOf, VOICE_LIMIT_WARNING_MS } = await import(
  "../../../../../src/renderer/components/chat/dictation"
);

const pill = (props: Partial<Parameters<typeof VoicePill>[0]> = {}) =>
  renderToStaticMarkup(
    <VoicePill
      phase="listening"
      level={0.5}
      elapsedMs={12_000}
      limitMs={600_000}
      onClick={() => {}}
      {...props}
    />,
  );

describe("the voice pill", () => {
  test("listening: the time it has listened and the square that finishes it, never red", () => {
    const html = pill();
    expect(html).toContain('data-phase="listening"');
    expect(html).toContain('aria-label="Finish voice input"');
    expect(html).toContain(">0:12<");
    // On hover, what a click does.
    expect(html).toContain(">Finish<");
    expect(html).toContain(">Enter<");
    expect(html).not.toContain("destructive");
    expect(html).not.toContain('disabled=""');
  });

  test("the clock warns as the server's limit nears", () => {
    expect(pill()).not.toContain("state-warning-fg");
    expect(pill({ elapsedMs: 600_000 - VOICE_LIMIT_WARNING_MS })).toContain("state-warning-fg");
    // A limit not told: no warning.
    expect(pill({ elapsedMs: 599_000, limitMs: null })).not.toContain("state-warning-fg");
  });

  test("narrow, it leaves out the time and the words", () => {
    const html = pill({ compact: true });
    expect(html).not.toContain(">0:12<");
    expect(html).not.toContain(">Finish<");
    expect(html).toContain('aria-label="Finish voice input"');
  });

  test("connecting, then finishing, which takes no click", () => {
    expect(pill({ phase: "starting" })).toContain(">Connecting<");
    expect(pill({ phase: "starting" })).not.toContain('disabled=""');
    const finishing = pill({ phase: "stopping" });
    expect(finishing).toContain(">Finishing<");
    expect(finishing).toContain('disabled=""');
  });

  test("its clock is minutes and seconds", () => {
    expect(clockOf(0)).toBe("0:00");
    expect(clockOf(12_345)).toBe("0:12");
    expect(clockOf(9 * 60_000 + 34_000)).toBe("9:34");
    expect(clockOf(-5)).toBe("0:00");
  });
});
