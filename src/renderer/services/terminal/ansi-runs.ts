export type Color = number | string;

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  hidden?: boolean;
}

export interface Run {
  text: string;
  style: Style;
  caret?: boolean;
}

const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escapes are what it reads
  /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|\x1b./g;

export function parseAnsi(text: string): Run[] {
  const runs: Run[] = [];
  let style: Style = {};
  let at = 0;
  const push = (part: string) => {
    if (!part) return;
    const last = runs.at(-1);
    if (last && last.style === style) last.text += part;
    else runs.push({ text: part, style });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  push(text.slice(at));
  return runs;
}

export function withCaret(runs: readonly Run[], column: number): Run[] {
  const out: Run[] = [];
  let left = column;
  let placed = false;
  for (const run of runs) {
    const chars = placed ? [] : Array.from(run.text);
    if (placed || left >= chars.length) {
      out.push(run);
      left -= chars.length;
      continue;
    }
    const before = chars.slice(0, left).join("");
    const after = chars.slice(left + 1).join("");
    if (before) out.push({ text: before, style: run.style });
    out.push({ text: chars[left] ?? " ", style: run.style, caret: true });
    if (after) out.push({ text: after, style: run.style });
    placed = true;
  }
  if (!placed) {
    if (left > 0) out.push({ text: " ".repeat(left), style: {} });
    out.push({ text: " ", style: {}, caret: true });
  }
  return out;
}

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

function applySgr(from: Style, params: string): Style {
  const codes = params === "" ? [0] : params.replace(/:/g, ";").split(";").map(toNumber);
  let style: Style = { ...from };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0;
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 8) style.hidden = true;
    else if (code === 9) style.strike = true;
    else if (code === 21 || code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 28) style.hidden = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = code - 30;
    else if (code === 39) style.fg = undefined;
    else if (code >= 40 && code <= 47) style.bg = code - 40;
    else if (code === 49) style.bg = undefined;
    else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const [color, used] = extended(codes, i + 1);
      if (color !== undefined) {
        if (code === 38) style.fg = color;
        else style.bg = color;
      }
      i += used;
    }
  }
  return style;
}

function extended(codes: number[], at: number): [Color | undefined, number] {
  const kind = codes[at];
  if (kind === 5) {
    const index = codes[at + 1];
    return [index !== undefined && index >= 0 && index < 256 ? index : undefined, 2];
  }
  if (kind === 2) {
    const rest = codes.slice(at + 1, at + 5);
    const rgb = rest.length === 4 && Number.isNaN(rest[0]) ? rest.slice(1) : rest.slice(0, 3);
    const used = rest.length === 4 && Number.isNaN(rest[0]) ? 5 : 4;
    if (rgb.length === 3 && rgb.every((v) => v >= 0 && v < 256)) {
      return [`#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`, used];
    }
    return [undefined, used];
  }
  return [undefined, 0];
}

function toNumber(code: string): number {
  return code === "" ? Number.NaN : Number(code);
}

export function paletteColor(index: number, sixteen: readonly string[]): string {
  if (index < 16) return sixteen[index] ?? "#ffffff";
  if (index < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const n = index - 16;
    const rgb = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map((i) => levels[i] ?? 0);
    return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${gray}${gray}${gray}`;
}

export function sixteenOf(theme: {
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}): string[] {
  return [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map((color) => color ?? "#ffffff");
}
