# Git lane OKLCH contrast measurement

Measured on 2026-05-11 for task 6 (git history graph lane/chip tokens).

## Method

- Input colors are the CSS OKLCH literals now defined in `src/renderer/styles/globals.css`.
- Conversion: Bun script using `culori.converter("rgb")` to convert OKLCH to sRGB, then clamp RGB channels to `[0, 1]`.
- Relative luminance: WCAG sRGB formula, linearizing each component with `c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4`, then `0.2126 R + 0.7152 G + 0.0722 B`.
- Contrast ratio: `(L1 + 0.05) / (L2 + 0.05)` with the lighter luminance as `L1`.
- Dark theme background: `#1a1917` (`--background`, luminance `0.009767`).
- Light theme background: `#faf9f6` (Warm Parchment, luminance `0.947292`).
- Acceptance threshold: WCAG non-text contrast ratio `>= 3:1`.

## Dark theme lane contrast against `#1a1917`

| Token | OKLCH | sRGB hex | Relative luminance | Contrast |
| --- | --- | --- | ---: | ---: |
| `--color-git-lane-0` | `oklch(0.56 0.070 55)` | `#95694c` | `0.170869` | `3.70:1` |
| `--color-git-lane-1` | `oklch(0.56 0.075 95)` | `#82743f` | `0.176270` | `3.79:1` |
| `--color-git-lane-2` | `oklch(0.56 0.070 145)` | `#5a805b` | `0.182713` | `3.89:1` |
| `--color-git-lane-3` | `oklch(0.56 0.065 190)` | `#42817d` | `0.183142` | `3.90:1` |
| `--color-git-lane-4` | `oklch(0.56 0.060 235)` | `#517a93` | `0.178634` | `3.83:1` |
| `--color-git-lane-5` | `oklch(0.56 0.065 285)` | `#706f9a` | `0.172055` | `3.72:1` |
| `--color-git-lane-6` | `oklch(0.56 0.070 330)` | `#8c6688` | `0.167760` | `3.64:1` |
| `--color-git-lane-7` | `oklch(0.56 0.065 25)` | `#976661` | `0.168761` | `3.66:1` |

## Light theme lane contrast against `#faf9f6`

| Token | OKLCH | sRGB hex | Relative luminance | Contrast |
| --- | --- | --- | ---: | ---: |
| `--color-git-lane-0` | `oklch(0.62 0.075 55)` | `#aa7a5a` | `0.232119` | `3.53:1` |
| `--color-git-lane-1` | `oklch(0.62 0.070 95)` | `#938654` | `0.239251` | `3.45:1` |
| `--color-git-lane-2` | `oklch(0.62 0.065 145)` | `#6e916e` | `0.246450` | `3.36:1` |
| `--color-git-lane-3` | `oklch(0.62 0.060 190)` | `#5a928e` | `0.246843` | `3.36:1` |
| `--color-git-lane-4` | `oklch(0.62 0.055 235)` | `#668ca3` | `0.241821` | `3.42:1` |
| `--color-git-lane-5` | `oklch(0.62 0.060 285)` | `#8281a9` | `0.234453` | `3.51:1` |
| `--color-git-lane-6` | `oklch(0.62 0.065 330)` | `#9d7899` | `0.229420` | `3.57:1` |
| `--color-git-lane-7` | `oklch(0.62 0.065 25)` | `#aa7772` | `0.229941` | `3.56:1` |

## Result

All 16 lane/theme pairs meet WCAG non-text contrast `>= 3:1` against their measured theme backgrounds.

Chip token note: dark HEAD chip uses Ash Gray on Earth Gray (`5.54:1`); light HEAD chip uses Earth Gray on Warm Parchment (`11.66:1`). Border and hover tokens are translucent neutral UI chrome, not lane colors.
