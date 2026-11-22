import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalPanel } from "../../../../../src/renderer/components/settings/panels/terminal-panel";
import {
  resolvedTerminalFontSize,
  useTerminalStore,
} from "../../../../../src/renderer/state/stores/terminal";

test("shows the font size a terminal draws with until the user picks one", () => {
  expect(useTerminalStore.getState().fontSize).toBeUndefined();
  const drawn = resolvedTerminalFontSize();
  const html = renderToStaticMarkup(<TerminalPanel />);
  expect(html).toContain(`value="${drawn}"`);
  expect(html).toContain(`font-size:${drawn}px`);
});
