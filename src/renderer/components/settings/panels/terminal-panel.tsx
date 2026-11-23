import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { TerminalCursorStyle, TerminalFontSize } from "../../../state/stores/terminal";
import { DEFAULT_TERMINAL_FONT_SIZE, useTerminalStore } from "../../../state/stores/terminal";
import { NumberInput } from "../../ui/number-input";
import { FontFamilyRow } from "../font-family-row";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";
import type { SegmentedOption } from "../segmented-control";
import { SegmentedControl } from "../segmented-control";
import { TerminalShellSection } from "./terminal-shell-section";

const FONT_SIZE_MIN: TerminalFontSize = 8;
const FONT_SIZE_MAX: TerminalFontSize = 32;

export function TerminalPanel() {
  const { t } = useTranslation("settings");

  const fontSize = useTerminalStore((s) => s.fontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const family = useTerminalStore((s) => s.fontFamily);
  const ligatures = useTerminalStore((s) => s.fontLigatures);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);
  const setFontFamily = useTerminalStore((s) => s.setFontFamily);
  const setFontLigatures = useTerminalStore((s) => s.setFontLigatures);

  const cursorOptions = useMemo<SegmentedOption<TerminalCursorStyle>[]>(
    () => [
      {
        value: "block",
        label: t("terminal.cursor.block"),
        icon: (
          <span className="inline-block bg-current align-middle" style={{ width: 7, height: 12 }} />
        ),
      },
      {
        value: "underline",
        label: t("terminal.cursor.underline"),
        icon: (
          <span
            className="inline-block bg-current align-middle"
            style={{ width: 8, height: 2, marginBottom: 1 }}
          />
        ),
      },
      {
        value: "bar",
        label: t("terminal.cursor.bar"),
        icon: (
          <span className="inline-block bg-current align-middle" style={{ width: 2, height: 12 }} />
        ),
      },
    ],
    [t],
  );

  const effectiveSize = fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
  const effectiveCursor: TerminalCursorStyle = cursorStyle ?? "block";
  const effectiveLigatures = ligatures ?? false;
  const previewFamilyStack = family && family !== "" ? family : "ui-monospace";

  return (
    <SettingsPage>
      <SettingsGroup>
        <TerminalShellSection />
      </SettingsGroup>

      <SettingsGroup title={t("terminal.font")}>
        <TerminalPreview
          fontFamily={previewFamilyStack}
          fontSize={effectiveSize}
          ligatures={effectiveLigatures}
          cursorStyle={effectiveCursor}
        />

        <FontFamilyRow scope="terminal" family={family} setFamily={setFontFamily} />

        <SettingsRow
          label={t("terminal.fontSize")}
          dirty={fontSize !== undefined}
          onReset={() => setFontSize(undefined)}
        >
          <NumberInput
            value={effectiveSize}
            onChange={(n) => setFontSize(n as TerminalFontSize)}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            suffix="px"
            ariaLabel={t("terminal.ariaFontSize")}
          />
        </SettingsRow>

        <SettingsRow
          label={t("terminal.cursorStyle")}
          dirty={cursorStyle !== undefined}
          onReset={() => setCursorStyle(undefined)}
        >
          <SegmentedControl
            options={cursorOptions}
            value={effectiveCursor}
            onChange={setCursorStyle}
            label={t("terminal.cursorStyle")}
          />
        </SettingsRow>

        <SettingsSwitch
          label={t("terminal.fontLigatures")}
          description={t("terminal.ligatures.description")}
          checked={effectiveLigatures}
          onChange={setFontLigatures}
          dirty={ligatures !== undefined}
          onReset={() => setFontLigatures(undefined)}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

function TerminalPreview({
  fontFamily,
  fontSize,
  ligatures,
  cursorStyle,
}: {
  fontFamily: string;
  fontSize: number;
  ligatures: boolean;
  cursorStyle: TerminalCursorStyle;
}) {
  const cellW = Math.round(fontSize * 0.6);
  const cellH = Math.round(fontSize * 1.2);
  const cursorStyleProps =
    cursorStyle === "block"
      ? { width: cellW, height: cellH }
      : cursorStyle === "underline"
        ? { width: cellW, height: 2 }
        : { width: 2, height: cellH };

  return (
    <div
      className={cn(
        "rounded-(--radius-control) border border-border bg-background px-3 py-2 text-foreground",
        "overflow-hidden",
      )}
      style={{
        fontFamily: `"${fontFamily}", ui-monospace, monospace`,
        fontSize,
        lineHeight: 1.4,
        fontFeatureSettings: ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      <div>
        <span className="text-muted-foreground">$ </span>
        <span>git push</span>
      </div>
      <div>{"=> != >= <= === -> |>"}</div>
      <div className="inline-flex items-baseline">
        <span className="text-muted-foreground">$ </span>
        <span
          aria-hidden="true"
          className={cn(
            "preview-cursor-blink inline-block bg-foreground align-baseline",
            cursorStyle === "underline" && "self-end",
          )}
          style={cursorStyleProps}
        />
      </div>
    </div>
  );
}
