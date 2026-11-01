import { afterEach, describe, expect, test } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SettingsRow,
  SettingsSection,
} from "../../../../../src/renderer/components/settings/section";

afterEach(async () => {
  await i18next.changeLanguage("en");
});

const noop = () => {};

describe("settings reset button", () => {
  test("names the setting in the UI language", async () => {
    await i18next.changeLanguage("ko");
    const html = renderToStaticMarkup(
      <SettingsRow label="창 불투명도" dirty onReset={noop}>
        <span />
      </SettingsRow>,
    );

    expect(html).toContain('aria-label="창 불투명도 초기화"');
    expect(html).not.toContain("Reset");
  });

  test("reads Reset <label> in English, in a section too", () => {
    const html = renderToStaticMarkup(
      <SettingsSection label="Theme" dirty onReset={noop}>
        <span />
      </SettingsSection>,
    );

    expect(html).toContain('aria-label="Reset Theme"');
  });
});
