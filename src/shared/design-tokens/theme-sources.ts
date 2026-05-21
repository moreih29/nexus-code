// theme-sources.ts — Raw color data for all registered themes.
//
// This file is the SINGLE SOURCE OF TRUTH for theme colors. Both:
//   - themes/index.ts (SemanticTokenSet for app chrome)
//   - shared/editor/palette.ts (EditorPalette for Monaco)
// derive their data from THEME_SOURCES via theme-adapter.ts.
//
// Adding a new theme = adding one ThemeSource record below.
// (And exporting the new id in themes/index.ts ThemeId union.)
//
// Values are taken from each theme's published source (VSCode marketplace
// theme files, official theme repos). Colors stay in their original
// representation — the adapter handles surface/state derivation.

// ---------------------------------------------------------------------------
// ThemeSource — minimal authoring contract per theme.
// ---------------------------------------------------------------------------

export interface ThemeSource {
  /** Kebab-case theme id (used as data-theme attribute value and registry key). */
  id: string;
  /** Display name shown in the Settings dialog. */
  name: string;
  /** Theme luminance base — controls Monaco vs/vs-dark inheritance. */
  base: "dark" | "light";
  /** One-line description shown next to the name in Settings. */
  description: string;

  // --- Core surface colors ---
  bg: {
    /** Primary editor canvas background (editor.background). */
    primary: string;
    /** Sidebar / panel / tab bar background — typically slightly darker/lighter than primary. */
    secondary: string;
    /** Dropdown / floating panel background (dialogs, command palette). */
    floating: string;
  };
  fg: {
    /** Primary text / icon color. */
    primary: string;
    /** Muted text — secondary labels, paths, inactive tab labels. */
    muted: string;
  };

  // --- Editor decorations ---
  /** Selection background — typically semi-transparent. */
  selection: string;
  /** Solid hex approximation of selection for xterm (which rejects alpha). */
  selectionSolid: string;
  /** Current line highlight. */
  lineHighlight: string;
  /** Caret color. */
  cursor: string;
  /** Subtle separator / border color. */
  border: string;
  /** Focus ring / primary accent. */
  accent: string;
  /** Find/match highlight (semi-transparent recommended). */
  findHighlight: string;
  /** Indent guide stroke. */
  indentGuide: string;

  // --- Syntax (15 roles per design.md §15.1 + LSP-specific parameter/method) ---
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    type: string;
    variable: string;
    constant: string;
    property: string;
    operator: string;
    tag: string;
    attribute: string;
    namespace: string;
    regexp: string;
    invalid: string;
    parameter: string;
    method: string;
  };

  // --- Terminal ANSI 16 (from each theme's published terminal.ansi* keys) ---
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };

  // --- Feedback / status semantics ---
  /** Success state foreground (git added, success toast, info badge). */
  success: string;
  /** Warning state foreground. */
  warning: string;
  /** Error state foreground (git conflict, diagnostic, destructive). */
  error: string;
  /** Info state foreground (git untracked, info badge). */
  info: string;

  // --- Claude indicator overrides (optional, issue #5) ---
  /**
   * Foreground color for the Claude attention glyph (tab.claude.attention.fg).
   * Required to satisfy WCAG 4.5:1 against the theme's island background.
   * Falls back to `source.info` in the adapter when not specified.
   * Use only when `source.info` fails the contrast gate against `bg.primary`.
   */
  claudeAttentionFg?: string;
}

// ---------------------------------------------------------------------------
// THEME_SOURCES — 10 popular themes imported from upstream definitions.
// ---------------------------------------------------------------------------

export const THEME_SOURCES = [
  // ===========================================================================
  // GitHub Dark — github/primer (default-dark)
  // ===========================================================================
  {
    id: "github-dark",
    name: "GitHub Dark",
    base: "dark",
    description: "GitHub의 공식 다크. 차분한 청록/파랑 강조, 비교적 낮은 채도",
    bg: { primary: "#0d1117", secondary: "#161b22", floating: "#161b22" },
    fg: { primary: "#c9d1d9", muted: "#8b949e" },
    selection: "rgba(56, 139, 253, 0.40)",
    selectionSolid: "#1f2d44",
    lineHighlight: "rgba(110, 118, 129, 0.10)",
    cursor: "#58a6ff",
    border: "#30363d",
    accent: "#1f6feb",
    findHighlight: "rgba(187, 128, 9, 0.40)",
    indentGuide: "rgba(110, 118, 129, 0.20)",
    syntax: {
      keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff",
      comment: "#8b949e", function: "#d2a8ff", type: "#ffa657",
      variable: "#c9d1d9", constant: "#79c0ff", property: "#79c0ff",
      operator: "#ff7b72", tag: "#7ee787", attribute: "#79c0ff",
      namespace: "#ffa657", regexp: "#7ee787", invalid: "#ffa198",
      parameter: "#ffa657", method: "#d2a8ff",
    },
    ansi: {
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    success: "#3fb950",
    warning: "#d29922",
    error: "#f85149",
    info: "#58a6ff",
  },

  // ===========================================================================
  // GitHub Light — github/primer (light_default)
  // ===========================================================================
  {
    id: "github-light",
    name: "GitHub Light",
    base: "light",
    description: "GitHub의 공식 라이트. 흰 배경, 진한 색 텍스트 — WCAG AA",
    bg: { primary: "#ffffff", secondary: "#f6f8fa", floating: "#ffffff" },
    fg: { primary: "#1f2328", muted: "#656d76" },
    selection: "rgba(9, 105, 218, 0.20)",
    selectionSolid: "#cce1f7",
    lineHighlight: "rgba(234, 238, 242, 0.50)",
    cursor: "#0969da",
    border: "#d0d7de",
    accent: "#0969da",
    findHighlight: "rgba(255, 223, 93, 0.55)",
    indentGuide: "rgba(208, 215, 222, 0.50)",
    syntax: {
      keyword: "#cf222e", string: "#0a3069", number: "#0550ae",
      comment: "#6e7781", function: "#8250df", type: "#953800",
      variable: "#1f2328", constant: "#0550ae", property: "#0550ae",
      operator: "#cf222e", tag: "#116329", attribute: "#0550ae",
      namespace: "#953800", regexp: "#116329", invalid: "#82071e",
      parameter: "#953800", method: "#8250df",
    },
    ansi: {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
      brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9",
      brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
    success: "#1a7f37",
    warning: "#9a6700",
    error: "#cf222e",
    info: "#0969da",
  },

  // ===========================================================================
  // Dracula — dracula-theme.com
  // ===========================================================================
  {
    id: "dracula",
    name: "Dracula",
    base: "dark",
    description: "전설적인 보라/핑크 다크. 강한 채도, 8색 팔레트가 핵심",
    bg: { primary: "#282a36", secondary: "#21222c", floating: "#343746" },
    fg: { primary: "#f8f8f2", muted: "#6272a4" },
    selection: "rgba(68, 71, 90, 0.65)",
    selectionSolid: "#44475a",
    lineHighlight: "rgba(68, 71, 90, 0.45)",
    cursor: "#f8f8f0",
    border: "#191a21",
    accent: "#bd93f9",
    findHighlight: "rgba(241, 250, 140, 0.30)",
    indentGuide: "rgba(98, 114, 164, 0.25)",
    syntax: {
      keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9",
      comment: "#6272a4", function: "#50fa7b", type: "#8be9fd",
      variable: "#f8f8f2", constant: "#bd93f9", property: "#f8f8f2",
      operator: "#ff79c6", tag: "#ff79c6", attribute: "#50fa7b",
      namespace: "#8be9fd", regexp: "#f1fa8c", invalid: "#ff5555",
      parameter: "#ffb86c", method: "#50fa7b",
    },
    ansi: {
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
      brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
      brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
    success: "#50fa7b",
    warning: "#f1fa8c",
    error: "#ff5555",
    info: "#8be9fd",
  },

  // ===========================================================================
  // One Dark Pro — zhuangtongfa
  // ===========================================================================
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    base: "dark",
    description: "Atom One Dark의 VSCode 포팅. 균형 잡힌 채도, 가장 무난한 다크",
    bg: { primary: "#282c34", secondary: "#21252b", floating: "#21252b" },
    fg: { primary: "#abb2bf", muted: "#5c6370" },
    selection: "rgba(62, 68, 81, 0.85)",
    selectionSolid: "#3e4451",
    lineHighlight: "rgba(44, 49, 60, 1.0)",
    cursor: "#528bff",
    border: "#181a1f",
    accent: "#61afef",
    findHighlight: "rgba(229, 192, 123, 0.30)",
    indentGuide: "rgba(92, 99, 112, 0.30)",
    syntax: {
      keyword: "#c678dd", string: "#98c379", number: "#d19a66",
      comment: "#5c6370", function: "#61afef", type: "#e5c07b",
      variable: "#e06c75", constant: "#d19a66", property: "#e06c75",
      operator: "#56b6c2", tag: "#e06c75", attribute: "#d19a66",
      namespace: "#e5c07b", regexp: "#56b6c2", invalid: "#f44747",
      parameter: "#abb2bf", method: "#61afef",
    },
    ansi: {
      black: "#3f4451", red: "#e05561", green: "#8cc265", yellow: "#d18f52",
      blue: "#4aa5f0", magenta: "#c162de", cyan: "#42b3c2", white: "#e6e6e6",
      brightBlack: "#4f5666", brightRed: "#ff616e", brightGreen: "#a5e075",
      brightYellow: "#f0a45d", brightBlue: "#4dc4ff", brightMagenta: "#de73ff",
      brightCyan: "#4cd1e0", brightWhite: "#d7dae0",
    },
    success: "#98c379",
    warning: "#e5c07b",
    error: "#e06c75",
    info: "#61afef",
  },

  // ===========================================================================
  // Monokai — Sublime Text classic (VSCode bundled)
  // ===========================================================================
  {
    id: "monokai",
    name: "Monokai",
    base: "dark",
    description: "Sublime Text의 클래식. 강한 채도, 마젠타/시안/노랑 트라이앵글",
    bg: { primary: "#272822", secondary: "#1e1f1c", floating: "#3e3d32" },
    fg: { primary: "#f8f8f2", muted: "#75715e" },
    selection: "rgba(73, 72, 62, 0.99)",
    selectionSolid: "#49483e",
    lineHighlight: "rgba(62, 61, 50, 1.0)",
    cursor: "#f8f8f0",
    border: "#1e1f1c",
    accent: "#a6e22e",
    findHighlight: "rgba(255, 224, 96, 0.30)",
    indentGuide: "rgba(117, 113, 94, 0.30)",
    syntax: {
      keyword: "#f92672", string: "#e6db74", number: "#ae81ff",
      comment: "#75715e", function: "#a6e22e", type: "#66d9ef",
      variable: "#f8f8f2", constant: "#ae81ff", property: "#a6e22e",
      operator: "#f92672", tag: "#f92672", attribute: "#a6e22e",
      namespace: "#66d9ef", regexp: "#e6db74", invalid: "#f8f8f0",
      parameter: "#fd971f", method: "#a6e22e",
    },
    ansi: {
      black: "#333333", red: "#c4265e", green: "#86b42b", yellow: "#b3b42b",
      blue: "#6a7ec8", magenta: "#8c6bc8", cyan: "#56adbc", white: "#e3e3dd",
      brightBlack: "#666666", brightRed: "#f92672", brightGreen: "#a6e22e",
      brightYellow: "#e2e22e", brightBlue: "#819aff", brightMagenta: "#ae81ff",
      brightCyan: "#66d9ef", brightWhite: "#f8f8f2",
    },
    success: "#a6e22e",
    warning: "#e6db74",
    error: "#f92672",
    info: "#66d9ef",
  },

  // ===========================================================================
  // Tokyo Night — enkia (storm variant blended for richer panel contrast)
  // ===========================================================================
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    base: "dark",
    description: "쿨톤 청보라. 차분하고 모던, 최근 가장 인기",
    bg: { primary: "#1a1b26", secondary: "#16161e", floating: "#1f2335" },
    fg: { primary: "#c0caf5", muted: "#565f89" },
    selection: "rgba(40, 52, 87, 0.85)",
    selectionSolid: "#283457",
    lineHighlight: "rgba(41, 46, 66, 1.0)",
    cursor: "#c0caf5",
    border: "#15161e",
    accent: "#7aa2f7",
    findHighlight: "rgba(224, 175, 104, 0.30)",
    indentGuide: "rgba(86, 95, 137, 0.25)",
    syntax: {
      keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64",
      comment: "#565f89", function: "#7aa2f7", type: "#2ac3de",
      variable: "#c0caf5", constant: "#ff9e64", property: "#73daca",
      operator: "#89ddff", tag: "#f7768e", attribute: "#bb9af7",
      namespace: "#2ac3de", regexp: "#b4f9f8", invalid: "#ff5370",
      parameter: "#e0af68", method: "#7aa2f7",
    },
    ansi: {
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    info: "#7dcfff",
  },

  // ===========================================================================
  // Solarized Dark — Ethan Schoonover (CIE-uniform palette)
  // ===========================================================================
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    base: "dark",
    description: "Ethan Schoonover의 클래식. CIE 명도 균일 — 눈 피로 적음",
    bg: { primary: "#002b36", secondary: "#073642", floating: "#073642" },
    fg: { primary: "#839496", muted: "#586e75" },
    selection: "rgba(7, 54, 66, 0.99)",
    selectionSolid: "#073642",
    lineHighlight: "rgba(7, 54, 66, 0.70)",
    cursor: "#93a1a1",
    border: "#073642",
    accent: "#268bd2",
    findHighlight: "rgba(181, 137, 0, 0.30)",
    indentGuide: "rgba(88, 110, 117, 0.30)",
    syntax: {
      keyword: "#859900", string: "#2aa198", number: "#d33682",
      comment: "#586e75", function: "#268bd2", type: "#b58900",
      variable: "#839496", constant: "#d33682", property: "#268bd2",
      operator: "#859900", tag: "#268bd2", attribute: "#93a1a1",
      namespace: "#b58900", regexp: "#dc322f", invalid: "#dc322f",
      parameter: "#cb4b16", method: "#268bd2",
    },
    ansi: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    info: "#268bd2",
    // #268bd2 (source.info) contrasts at 4.08:1 against #002b36 (bg.primary) — fails WCAG 4.5:1.
    // Brightened Solarized blue (#2397e8) reaches 4.76:1 while preserving the CIE-uniform hue.
    claudeAttentionFg: "#2397e8",
  },

  // ===========================================================================
  // Nord — Arctic, north-bluish (16-color subset)
  // ===========================================================================
  {
    id: "nord",
    name: "Nord",
    base: "dark",
    description: "Arctic, north-bluish. 16색의 절제된 팔레트로 유명",
    bg: { primary: "#2e3440", secondary: "#3b4252", floating: "#3b4252" },
    fg: { primary: "#d8dee9", muted: "#616e88" },
    selection: "rgba(67, 76, 94, 0.99)",
    selectionSolid: "#434c5e",
    lineHighlight: "rgba(59, 66, 82, 0.65)",
    cursor: "#d8dee9",
    border: "#3b4252",
    accent: "#88c0d0",
    findHighlight: "rgba(235, 203, 139, 0.30)",
    indentGuide: "rgba(76, 86, 106, 0.30)",
    syntax: {
      keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead",
      comment: "#616e88", function: "#88c0d0", type: "#8fbcbb",
      variable: "#d8dee9", constant: "#5e81ac", property: "#8fbcbb",
      operator: "#81a1c1", tag: "#81a1c1", attribute: "#8fbcbb",
      namespace: "#8fbcbb", regexp: "#ebcb8b", invalid: "#bf616a",
      parameter: "#d8dee9", method: "#88c0d0",
    },
    ansi: {
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
    success: "#a3be8c",
    warning: "#ebcb8b",
    error: "#bf616a",
    info: "#88c0d0",
  },

  // ===========================================================================
  // Catppuccin Mocha — soothing pastel theme (mocha = darkest flavor)
  // ===========================================================================
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    base: "dark",
    description: "파스텔 톤의 차분한 다크. 4 flavor 중 가장 어두운 mocha",
    bg: { primary: "#1e1e2e", secondary: "#181825", floating: "#313244" },
    fg: { primary: "#cdd6f4", muted: "#6c7086" },
    selection: "rgba(88, 91, 112, 0.65)",
    selectionSolid: "#585b70",
    lineHighlight: "rgba(49, 50, 68, 0.99)",
    cursor: "#f5e0dc",
    border: "#181825",
    accent: "#89b4fa",
    findHighlight: "rgba(249, 226, 175, 0.30)",
    indentGuide: "rgba(108, 112, 134, 0.25)",
    syntax: {
      keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387",
      comment: "#6c7086", function: "#89b4fa", type: "#f9e2af",
      variable: "#cdd6f4", constant: "#fab387", property: "#89dceb",
      operator: "#94e2d5", tag: "#f38ba8", attribute: "#cba6f7",
      namespace: "#f9e2af", regexp: "#f5c2e7", invalid: "#f38ba8",
      parameter: "#eba0ac", method: "#89b4fa",
    },
    ansi: {
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
    success: "#a6e3a1",
    warning: "#f9e2af",
    error: "#f38ba8",
    info: "#89dceb",
  },

  // ===========================================================================
  // Gruvbox Dark — morhetz (retro-groove warm palette)
  // ===========================================================================
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    base: "dark",
    description: "Retro groovy. 따뜻한 갈색·올리브·머스타드 톤",
    bg: { primary: "#282828", secondary: "#1d2021", floating: "#3c3836" },
    fg: { primary: "#ebdbb2", muted: "#928374" },
    selection: "rgba(80, 73, 69, 0.99)",
    selectionSolid: "#504945",
    lineHighlight: "rgba(60, 56, 54, 1.0)",
    cursor: "#ebdbb2",
    border: "#3c3836",
    accent: "#fabd2f",
    findHighlight: "rgba(250, 189, 47, 0.30)",
    indentGuide: "rgba(146, 131, 116, 0.25)",
    syntax: {
      keyword: "#fb4934", string: "#b8bb26", number: "#d3869b",
      comment: "#928374", function: "#b8bb26", type: "#fabd2f",
      variable: "#ebdbb2", constant: "#d3869b", property: "#83a598",
      operator: "#fe8019", tag: "#fb4934", attribute: "#8ec07c",
      namespace: "#fabd2f", regexp: "#fe8019", invalid: "#fb4934",
      parameter: "#fabd2f", method: "#b8bb26",
    },
    ansi: {
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26",
      brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
      brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
    success: "#b8bb26",
    warning: "#fabd2f",
    error: "#fb4934",
    info: "#83a598",
  },
] as const satisfies readonly ThemeSource[];

// ---------------------------------------------------------------------------
// ThemeId — string union derived from THEME_SOURCES.
// Adding a new theme to THEME_SOURCES automatically widens this type.
// ---------------------------------------------------------------------------

export type ThemeId = (typeof THEME_SOURCES)[number]["id"];

/** Default theme applied on first boot and as the :root fallback. */
export const DEFAULT_THEME: ThemeId = "github-dark";

/** Map of id → source for O(1) lookup by adapter/UI code. */
export const THEME_SOURCE_BY_ID: Record<ThemeId, ThemeSource> = Object.fromEntries(
  THEME_SOURCES.map((s) => [s.id, s]),
) as Record<ThemeId, ThemeSource>;
