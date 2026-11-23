#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

type Language = "ts" | "go" | "css" | "shell";

interface Span {
  start: number;
  end: number;
  text: string;
}

interface FileResult {
  file: string;
  language: Language;
  removed: Span[];
  kept: { span: Span; reason: string }[];
}

const ROOT = join(import.meta.dir, "..");

const EXCLUDED_FILES = new Set<string>(["src/renderer/styles/theme.generated.css"]);

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const TS_KEEP: [RegExp, string][] = [
  [/^\/\/\/\s*<(reference|amd-module|amd-dependency)\b/, "triple-slash directive"],
  [/^\/[/*]\s*@ts-(expect-error|ignore|nocheck|check)\b/, "typescript directive"],
  [/^\/[/*]\s*biome-ignore/, "biome suppression"],
  [/^\/[/*]\s*eslint-(disable|enable)/, "eslint directive"],
  [/^\/\*\s*@vite-ignore\s*\*\/$/, "vite magic comment"],
  [/^\/\*\s*[#@]__(PURE|NO_SIDE_EFFECTS|INLINE)__\s*\*\/$/, "bundler annotation"],
  [/^\/[/*]\*?\s*@(vitest|jest)-environment\b/, "test environment pragma"],
  [/^\/[/*]\*?\s*@jsx(ImportSource|Runtime|Frag)?\b/, "jsx pragma"],
  [/^\/\*\s*webpack[A-Z]\w*\s*:/, "bundler magic comment"],
  [/^\/[/*]\s*(c8|v8|istanbul)\s+ignore\b/, "coverage directive"],
  [/^\/[/*]\s*@refresh\s+reset\b/, "react refresh directive"],
  [/^\/\*!/, "license"],
  [/@license\b|@preserve\b|SPDX-License-Identifier|\bCopyright\s+(\(c\)|©|\d{4})/i, "license"],
];

const GO_KEEP: [RegExp, string][] = [
  [/^\/\/go:[a-z]+/, "go directive"],
  [/^\/\/ \+build\b/, "build constraint"],
  [/^\/\/\s*nolint\b/, "nolint directive"],
  [/^\/\/export\s/, "cgo export"],
  [/^\/\/line\s/, "line directive"],
  [/^\/\/lint:/, "lint directive"],
  [/^\/\/\s*(Unordered output|Output):/, "example output"],
  [/@license\b|SPDX-License-Identifier|\bCopyright\s+(\(c\)|©|\d{4})/i, "license"],
];

const CSS_KEEP: [RegExp, string][] = [
  [/^\/\*\s*biome-ignore/, "biome suppression"],
  [/^\/\*!/, "license"],
  [/@license\b|SPDX-License-Identifier|\bCopyright\s+(\(c\)|©|\d{4})/i, "license"],
];

const SHELL_KEEP: [RegExp, string][] = [
  [/^#\s*shellcheck\s/, "shellcheck directive"],
  [
    /^# nexus-code claude wrapper\b/,
    "wrapper magic header read by find_real_claude and internal/lsp",
  ],
];

const GENERATED = /Code generated .* DO NOT EDIT\.|@generated\b/;

function keepReason(text: string, rules: [RegExp, string][]): string | null {
  for (const [pattern, reason] of rules) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function languageOf(file: string): Language | null {
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".sh") || file.endsWith(".bash")) return "shell";
  if (TS_EXTENSIONS.some((ext) => file.endsWith(ext))) return "ts";
  return null;
}

function trackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout.split("\0").filter((file) => file.length > 0);
}

function isExcluded(file: string): boolean {
  return EXCLUDED_FILES.has(file);
}

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function tsComments(file: string, text: string): { spans: Span[]; jsxEmpty: Span[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const found = new Map<number, Span>();
  const jsxEmpty: Span[] = [];
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (!found.has(range.pos)) {
        found.set(range.pos, {
          start: range.pos,
          end: range.end,
          text: text.slice(range.pos, range.end),
        });
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      jsxEmpty.push({ start: node.getStart(source), end: node.end, text: node.getText(source) });
    }
    const children = node.getChildren(source);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.JsxText) {
        add(ts.getLeadingCommentRanges(text, node.pos));
        add(ts.getTrailingCommentRanges(text, node.end));
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  const spans = [...found.values()].sort((a, b) => a.start - b.start);
  return { spans, jsxEmpty };
}

function cssComments(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      spans.push({ start: i, end, text: text.slice(i, end) });
      i = end;
      continue;
    }
    i++;
  }
  return spans;
}

function shellComments(text: string): Span[] {
  const spans: Span[] = [];
  let heredoc: string | null = null;
  let offset = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineStart = offset;
    offset += line.length + 1;
    if (heredoc !== null) {
      const body = line.replace(/^\t+/, "");
      if (body === heredoc) heredoc = null;
      continue;
    }
    const trimmed = line.trimStart();
    if (index === 0 && trimmed.startsWith("#!")) continue;
    if (trimmed.startsWith("#")) {
      const start = lineStart + (line.length - trimmed.length);
      spans.push({ start, end: lineStart + line.length, text: trimmed });
      continue;
    }
    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opener) heredoc = opener[2];
  }
  return spans;
}

let goCache: Map<string, { generated: boolean; comments: (Span & { cgo: boolean })[] }> | null =
  null;

function loadGoComments(files: string[]) {
  goCache = new Map();
  if (files.length === 0) return;
  const out = spawnSync("go", ["run", "./scripts/strip-comments", ...files], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (out.status !== 0) throw new Error(out.stderr);
  const parsed = JSON.parse(out.stdout) as {
    file: string;
    generated: boolean;
    error?: string;
    comments: { start: number; end: number; text: string; cgo: boolean }[];
  }[];
  for (const entry of parsed) {
    if (entry.error) throw new Error(`${entry.file}: ${entry.error}`);
    goCache.set(entry.file, { generated: entry.generated, comments: entry.comments });
  }
}

function isHorizontalSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

const OPENERS = new Set(["{", "(", "["]);
const CLOSERS = new Set(["}", ")", "]"]);

function removeSpans(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let result = text;
  const removedLineMarks: number[] = [];
  const edit = (from: number, to: number, insert = "") => {
    result = result.slice(0, from) + insert + result.slice(to);
    const shift = to - from - insert.length;
    for (let i = 0; i < removedLineMarks.length; i++) removedLineMarks[i] -= shift;
  };
  for (const span of sorted) {
    let left = span.start;
    while (left > 0 && isHorizontalSpace(result[left - 1])) left--;
    let right = span.end;
    while (right < result.length && isHorizontalSpace(result[right])) right++;
    const atLineStart = left === 0 || result[left - 1] === "\n";
    const atLineEnd = right === result.length || result[right] === "\n" || result[right] === "\r";
    if (atLineStart && atLineEnd) {
      let cut = right;
      if (result[cut] === "\r") cut++;
      if (result[cut] === "\n") cut++;
      edit(left, cut);
      removedLineMarks.push(left);
      continue;
    }
    if (atLineEnd) {
      edit(left, right);
      continue;
    }
    if (atLineStart) {
      edit(span.start, right);
      continue;
    }
    const before = result[left - 1];
    const after = result[right];
    const hadSpace = left < span.start || right > span.end;
    if (CLOSERS.has(after) || after === "," || after === ";") {
      edit(left, right);
    } else if (left < span.start) {
      edit(span.start, right);
    } else if (OPENERS.has(before)) {
      edit(left, right);
    } else if (!hadSpace && isWordChar(before) && isWordChar(after)) {
      edit(left, right, " ");
    } else {
      edit(left, right, hadSpace ? " " : "");
    }
  }
  return tidyBlankLines(result, removedLineMarks);
}

function lineIndexAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function tidyBlankLines(text: string, marks: number[]): string {
  if (marks.length === 0) return text;
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const touched = new Set<number>();
  for (const mark of marks) touched.add(lineIndexAt(lineStarts, Math.min(mark, text.length)));
  const drop = new Set<number>();
  const blank = (index: number) => index >= 0 && index < lines.length && lines[index].trim() === "";
  const prevKept = (index: number) => {
    let i = index - 1;
    while (i >= 0 && drop.has(i)) i--;
    return i;
  };
  const nextKept = (index: number) => {
    let i = index + 1;
    while (i < lines.length && drop.has(i)) i++;
    return i;
  };
  const opensBlock = (index: number) => {
    if (index < 0) return true;
    const trimmed = lines[index].trimEnd();
    const last = trimmed[trimmed.length - 1];
    return OPENERS.has(last) || trimmed.endsWith("=>") || trimmed.endsWith(":");
  };
  const closesBlock = (index: number) => {
    if (index >= lines.length) return true;
    const first = lines[index].trimStart()[0];
    return first !== undefined && CLOSERS.has(first);
  };
  const atEnd = (index: number) => {
    for (let i = index; i < lines.length; i++) if (!drop.has(i) && !blank(i)) return false;
    return true;
  };
  for (const index of [...touched].sort((a, b) => a - b)) {
    const above = index - 1;
    if (blank(above) && !drop.has(above)) {
      const beforeAbove = prevKept(above);
      if (beforeAbove < 0 || opensBlock(beforeAbove) || blank(beforeAbove)) drop.add(above);
    }
    if (blank(index) && !drop.has(index)) {
      const previous = prevKept(index);
      const following = nextKept(index);
      if (
        previous < 0 ||
        opensBlock(previous) ||
        blank(previous) ||
        closesBlock(following) ||
        atEnd(following)
      ) {
        if (!(following >= lines.length && index === lines.length - 1)) drop.add(index);
      }
    } else if (blank(above) && !drop.has(above) && closesBlock(index)) {
      drop.add(above);
    }
  }
  const kept = lines.filter((_, index) => !drop.has(index));
  while (kept.length > 1 && kept[0].trim() === "") kept.shift();
  return kept.join("\n");
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function processFile(file: string): { result: FileResult; output: string; input: string } | null {
  const language = languageOf(file);
  if (language === null) return null;
  const input = readFileSync(join(ROOT, file), "utf8");
  const result: FileResult = { file, language, removed: [], kept: [] };
  const removeSpansList: Span[] = [];
  const decide = (span: Span, rules: [RegExp, string][]) => {
    const reason = keepReason(span.text, rules);
    if (reason) result.kept.push({ span, reason });
    else {
      result.removed.push(span);
      removeSpansList.push(span);
    }
  };
  if (language === "ts") {
    const { spans, jsxEmpty } = tsComments(file, input);
    if (spans.length > 0 && GENERATED.test(spans[0].text)) {
      for (const span of spans) result.kept.push({ span, reason: "generated file" });
      return { result, output: input, input };
    }
    const covered: Span[] = [];
    for (const block of jsxEmpty) {
      const inner = spans.filter((span) => span.start >= block.start && span.end <= block.end);
      if (inner.some((span) => keepReason(span.text, TS_KEEP) !== null)) continue;
      covered.push(block);
      for (const span of inner) result.removed.push(span);
    }
    const insideCovered = (span: Span) =>
      covered.some((block) => span.start >= block.start && span.end <= block.end);
    for (const span of spans) {
      if (insideCovered(span)) continue;
      decide(span, TS_KEEP);
    }
    removeSpansList.push(...covered);
  } else if (language === "go") {
    const entry = goCache?.get(file);
    if (!entry) throw new Error(`no Go scan for ${file}`);
    if (entry.generated) {
      for (const c of entry.comments) result.kept.push({ span: c, reason: "generated file" });
      return { result, output: input, input };
    }
    for (const c of entry.comments) {
      if (c.cgo) result.kept.push({ span: c, reason: "cgo preamble" });
      else decide(c, GO_KEEP);
    }
  } else if (language === "css") {
    const spans = cssComments(input);
    if (spans.length > 0 && GENERATED.test(spans[0].text)) return { result, output: input, input };
    for (const span of spans) decide(span, CSS_KEEP);
  } else {
    for (const span of shellComments(input)) decide(span, SHELL_KEEP);
  }
  result.removed.sort((a, b) => a.start - b.start);
  const output = removeSpansList.length > 0 ? removeSpans(input, removeSpansList) : input;
  return { result, output, input };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
  const explicit = args.filter(
    (arg, index) => !arg.startsWith("--") && (reportIndex < 0 || index !== reportIndex + 1),
  );
  const files = (
    explicit.length > 0 ? explicit.map((f) => relative(ROOT, join(ROOT, f))) : trackedFiles()
  ).filter((file) => languageOf(file) !== null && !isExcluded(file));
  loadGoComments(files.filter((file) => file.endsWith(".go")));

  const report: {
    file: string;
    language: Language;
    removed: { line: number; text: string }[];
    kept: { line: number; text: string; reason: string }[];
  }[] = [];
  const changedGo: string[] = [];
  const changedOther: string[] = [];
  let violations = 0;
  for (const file of files) {
    const processed = processFile(file);
    if (!processed) continue;
    const { result, output, input } = processed;
    report.push({
      file,
      language: result.language,
      removed: result.removed.map((span) => ({ line: lineOf(input, span.start), text: span.text })),
      kept: result.kept.map(({ span, reason }) => ({
        line: lineOf(input, span.start),
        text: span.text,
        reason,
      })),
    });
    if (check) {
      for (const span of result.removed) {
        const firstLine = span.text.split("\n")[0];
        console.log(`${file}:${lineOf(input, span.start)}: ${firstLine.slice(0, 120)}`);
        violations++;
      }
      continue;
    }
    if (output !== input) {
      writeFileSync(join(ROOT, file), output);
      if (file.endsWith(".go")) changedGo.push(file);
      else changedOther.push(file);
    }
  }
  if (!check && changedGo.length > 0) {
    const gofmt = spawnSync("gofmt", ["-w", ...changedGo], { cwd: ROOT, encoding: "utf8" });
    if (gofmt.status !== 0) throw new Error(gofmt.stderr);
  }
  if (!check && changedOther.length > 0) {
    const biome = spawnSync(
      join(ROOT, "node_modules/.bin/biome"),
      [
        "check",
        "--write",
        "--linter-enabled=false",
        "--no-errors-on-unmatched",
        "--files-ignore-unknown=true",
        ...changedOther,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 },
    );
    if (biome.status !== 0) throw new Error(biome.stdout + biome.stderr);
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (check && violations > 0) {
    console.error(
      `${violations} comment(s) outside the allowed list. Run: bun run scripts/strip-comments.ts`,
    );
    process.exit(1);
  }
}

main();
