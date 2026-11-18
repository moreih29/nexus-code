import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { ChatConfig } from "../../../../../packages/remote-protocol/src";
import { CodexConfigRow } from "../../../../../src/renderer/components/chat/codex-config-dialog";
import { createI18n } from "../../../../../src/shared/i18n";

const choiceLabels = [
  ["model", "Default model", "기본 모델"],
  ["approval_policy", "Default approval policy", "기본 승인 정책"],
  ["sandbox_mode", "Default sandbox", "기본 샌드박스"],
  ["service_tier", "Default service tier", "기본 서비스 등급"],
  ["web_search", "Default web search", "기본 웹 검색"],
] as const;

describe("Codex defaults row descriptions", () => {
  test.each(["en", "ko"] as const)("renders optional descriptions in %s", async (lng) => {
    const i18n = createInstance();
    await i18n.init(createI18n({ lng }).options);

    const renderRow = (key: string, kind: ChatConfig["keys"][number]["kind"]) =>
      renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <CodexConfigRow
            setting={{ key, kind, group: "conversation" }}
            busy={false}
            dirty={false}
            invalid={false}
            modelChanged={false}
            onChange={() => {}}
          />
        </I18nextProvider>,
      );

    for (const [key, en, ko] of choiceLabels) {
      const html = renderRow(key, "choice");
      expect(html).toContain(lng === "en" ? en : ko);
      expect(html).not.toContain("<p ");
    }

    for (const kind of ["choice", "text"] as const) {
      const html = renderRow("future_host_setting", kind);
      expect(html).toContain("future_host_setting");
      expect(html).not.toContain("<p ");
    }

    expect(renderRow("model_context_window", "text")).toContain(
      lng === "en"
        ? "Context capacity in tokens. Codex caps it at the model’s known maximum."
        : "토큰 단위의 컨텍스트 용량입니다. Codex는 모델의 알려진 최댓값을 적용합니다.",
    );
    expect(renderRow("plan_mode_reasoning_effort", "choice")).toContain(
      lng === "en"
        ? "Choose the reasoning effort Codex uses in Plan mode."
        : "Codex가 계획 모드에서 사용할 추론 강도를 선택합니다.",
    );
  });
});
