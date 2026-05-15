/**
 * Token assertion for Git destructive/error text on dark Source Control
 * surfaces. This guards against returning to the low-contrast global
 * `text-destructive` token for small popover/banner text.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { converter } from "culori";
import { color } from "../../../../../../src/shared/design-tokens/design-tokens";

const MIN_SMALL_TEXT_CONTRAST = 4.5;
const GIT_DESTRUCTIVE_CLASS = "git-destructive-text";
const GIT_SURFACE_FILES = [
  "src/renderer/components/files/git/GitCommitButton.tsx",
  "src/renderer/components/files/git/GitFileContextMenu.tsx",
  "src/renderer/components/files/git/GitFileRow.tsx",
  "src/renderer/components/files/git/GitGroupHeader.tsx",
  "src/renderer/components/files/git/GitInlineBanner.tsx",
  "src/renderer/components/files/git/GitMoreMenu.tsx",
  "src/renderer/components/files/git/GitStatusBadge.tsx",
  "src/renderer/components/files/git/GitTreeRow.tsx",
  "src/renderer/components/files/git/OperationBanner.tsx",
  "src/renderer/components/files/git/history/HistoryCommitMenu.tsx",
  "src/renderer/components/files/git/CloneDialog.tsx",
  "src/renderer/components/files/git/GitPanel.tsx",
  "src/renderer/components/files/git/TagPicker.tsx",
] as const;

describe("Git destructive text contrast", () => {
  it("keeps the Git destructive utility readable on popover and canvas backgrounds", () => {
    const textColor = readGitDestructiveTextColor();

    expect(contrastRatio(textColor, color.mutedSurfaceHex)).toBeGreaterThanOrEqual(
      MIN_SMALL_TEXT_CONTRAST,
    );
    expect(contrastRatio(textColor, color.bgCanvas)).toBeGreaterThanOrEqual(
      MIN_SMALL_TEXT_CONTRAST,
    );
  });

  it("uses the scoped Git destructive utility in small Git UI surfaces", () => {
    for (const file of GIT_SURFACE_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("text-destructive");
      expect(source).toContain(GIT_DESTRUCTIVE_CLASS);
    }
  });
});

/** Extracts the CSS literal used by the git-destructive-text utility. */
function readGitDestructiveTextColor(): string {
  const css = readFileSync("src/renderer/styles/globals.css", "utf8");
  const match = /@utility\s+git-destructive-text\s*{\s*color:\s*(#[0-9a-fA-F]{6})\s*;/m.exec(css);
  if (!match?.[1]) throw new Error("git-destructive-text utility color not found");
  return match[1];
}

const toRgb = converter("rgb");

/** Computes WCAG contrast for two CSS colors. */
function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Converts sRGB into WCAG relative luminance. */
function relativeLuminance(input: string): number {
  const rgb = toRgb(input);
  if (!rgb) throw new Error(`Could not parse color: ${input}`);
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((component) => {
    const clamped = Math.min(1, Math.max(0, component));
    return clamped <= 0.03928 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
