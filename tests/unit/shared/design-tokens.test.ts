/**
 * Design token coverage + WCAG contrast gate — issue #5 new tokens.
 *
 * Acceptance criteria (task spec):
 *   - 10 themes × 4 new semantic keys = 40 defined values (no missing / undefined).
 *   - tab.claude.attention.fg against surface.island.bg ≥ 4.5:1 for every theme.
 *   - tab.claude.attention.fg vs state.warning.fg (SSH connecting) must be
 *     perceptually different — not the same value — across all themes.
 *
 * New keys covered:
 *   tab.claude.running.fg     — loader glyph (aliases accent)
 *   tab.claude.attention.fg   — needsInput glyph (info hue, distinct from SSH yellow)
 *   tab.attention.indicator   — inactive tab left 2px bar (info hue)
 *   (state.warning.fg / state.warning.bg already existed — not new, verified by TS2741)
 */

import { describe, expect, it } from "bun:test";
import { converter, parse, wcagContrast } from "culori";
import { buildSemanticTokens } from "../../../src/shared/design-tokens/theme-adapter";
import { THEME_SOURCES } from "../../../src/shared/design-tokens/theme-sources";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toRgb = converter("rgb");

/** WCAG relative luminance of a CSS color string. Returns -1 on parse failure. */
function luminance(color: string): number {
  const parsed = parse(color);
  if (!parsed) return -1;
  const rgb = toRgb(parsed);
  if (!rgb) return -1;
  // IEC 61966-2-1 linearization
  function lin(c: number): number {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG 2.x contrast ratio between two colors. */
function contrast(c1: string, c2: string): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  if (l1 < 0 || l2 < 0) return 0;
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_KEYS = [
  "tab.claude.running.fg",
  "tab.claude.attention.fg",
  "tab.attention.indicator",
] as const;

const ALL_THEMES = THEME_SOURCES.map((s) => ({ id: s.id, tokens: buildSemanticTokens(s) }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("design-tokens — new tab.claude.* keys", () => {
  it("all 10 themes define all 3 new keys (token coverage — 30 values)", () => {
    for (const { id, tokens } of ALL_THEMES) {
      for (const key of NEW_KEYS) {
        const value = tokens[key];
        expect(
          value,
          `theme "${id}" is missing token "${key}"`,
        ).toBeTruthy();
        expect(
          typeof value,
          `theme "${id}" token "${key}" must be a string`,
        ).toBe("string");
      }
    }
  });

  it("state.warning.fg already defined in all 10 themes (pre-existing key)", () => {
    for (const { id, tokens } of ALL_THEMES) {
      const value = tokens["state.warning.fg"];
      expect(value, `theme "${id}" missing state.warning.fg`).toBeTruthy();
    }
  });

  it("state.warning.bg already defined in all 10 themes (pre-existing key)", () => {
    for (const { id, tokens } of ALL_THEMES) {
      const value = tokens["state.warning.bg"];
      expect(value, `theme "${id}" missing state.warning.bg`).toBeTruthy();
    }
  });

  describe("WCAG contrast gate — tab.claude.attention.fg vs surface.island.bg ≥ 4.5:1", () => {
    for (const { id, tokens } of ALL_THEMES) {
      it(`${id}: attention.fg contrast ≥ 4.5:1 against island.bg`, () => {
        const attFg = tokens["tab.claude.attention.fg"];
        const islandBg = tokens["surface.island.bg"];
        const ratio = contrast(attFg, islandBg);
        expect(
          ratio,
          `theme "${id}": tab.claude.attention.fg (${attFg}) vs surface.island.bg (${islandBg}) = ${ratio.toFixed(2)}:1, need ≥ 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  describe("visual separation — tab.claude.attention.fg !== state.warning.fg (SSH connecting)", () => {
    for (const { id, tokens } of ALL_THEMES) {
      it(`${id}: attention.fg is distinct from warning.fg`, () => {
        const attFg = tokens["tab.claude.attention.fg"];
        const warnFg = tokens["state.warning.fg"];
        expect(
          attFg,
          `theme "${id}": tab.claude.attention.fg should not equal state.warning.fg ("${warnFg}") — must be visually distinct from SSH connecting yellow`,
        ).not.toBe(warnFg);
      });
    }
  });
});
