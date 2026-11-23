import { expect, test } from "bun:test";
import i18next from "i18next";
import { commitTabErrorFrom } from "../../../../../src/renderer/components/editor/commit-tab";
import { createI18n } from "../../../../../src/shared/i18n";

test("commit load uses translated messages for missing refs and other git failures", async () => {
  const originalLanguage = i18next.language;
  await i18next.init(createI18n({ lng: "ko" }).options);
  try {
    const sha = "abc123456789";
    const raw = new Error("fatal: cannot read /private/repo");
    expect(commitTabErrorFrom(raw, sha)).toEqual({
      notFound: false,
      message: "커밋 세부정보 로드에 실패했습니다.",
    });
    const missing = Object.assign(new Error("fatal: invalid object"), { kind: "ref-not-found" });
    expect(commitTabErrorFrom(missing, sha)).toEqual({
      notFound: true,
      message: "커밋 abc1234: 저장소에서 찾을 수 없습니다",
    });
  } finally {
    await i18next.changeLanguage(originalLanguage ?? "en");
  }
});
