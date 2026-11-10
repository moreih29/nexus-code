/**
 * Where a browser tab's pick button sends the picked element: the live agent
 * sessions of the tab's own workspace, how the menu tells them apart, and
 * the text as the terminal's prompt takes it with and without bracketed
 * paste.
 */
import { describe, expect, it } from "bun:test";
import { pasteForTerminal } from "../../../../../src/renderer/services/browser/element-pick";

describe("pasteForTerminal", () => {
  const text =
    '[element in browser tab 7c8a] http://x/\n  button "Sign in" (ref e7)\n  selector: #go';

  it("keeps the lines and ends below them with bracketed paste", () => {
    expect(pasteForTerminal(text, true)).toBe(`${text}\n`);
  });

  it("joins the lines without it, so no line break acts as Enter", () => {
    const pasted = pasteForTerminal(text, false);
    expect(pasted).toBe(
      '[element in browser tab 7c8a] http://x/ | button "Sign in" (ref e7) | selector: #go ',
    );
    expect(pasted).not.toMatch(/[\r\n]/);
  });

  it("drops what could end the paste early or press keys", () => {
    const hostile = 'html: <b title="\u001b[201~rm -rf ~\r">\u0003\u0015x\u009b2J\ty</b>';
    expect(pasteForTerminal(hostile, true)).toBe('html: <b title="[201~rm -rf ~">x2J\ty</b>\n');
    expect(pasteForTerminal(hostile, false)).toBe('html: <b title="[201~rm -rf ~">x2J y</b> ');
  });
});
