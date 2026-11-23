import { expect, test } from "bun:test";
import i18next from "i18next";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { KeychainLockedRowView } from "../../../../src/renderer/components/keychain/keychain-locked";

async function renderIn(language: string, node: ReactElement): Promise<string> {
  const i18n = i18next.cloneInstance({ lng: language });
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

test.each([
  ["remote", "원격 꺼짐 · 저장된 로그인 열기 전"],
  ["voices", "이름 제안 꺼짐 · 기억한 목소리 열기 전"],
] as const)("put off: %s says what waits, with the button", async (item, description) => {
  const html = await renderIn("ko", <KeychainLockedRowView item={item} refused={false} />);
  expect(html).toContain("키체인 잠김");
  expect(html).toContain(description);
  expect(html).toContain(">열기</button>");
});

test.each([
  ["ko", "키체인 잠김", "macOS에서 거부됨 · 앱을 다시 시작하면 다시 요청"],
  ["en", "Keychain locked", "Refused in macOS · asked again after the app restarts"],
] as const)("refused (%s): a restart asks again, and no button", async (language, title, text) => {
  for (const item of ["remote", "voices"] as const) {
    const html = await renderIn(language, <KeychainLockedRowView item={item} refused />);
    expect(html).toContain(title);
    expect(html).toContain(text);
    expect(html).not.toContain("<button");
  }
});
