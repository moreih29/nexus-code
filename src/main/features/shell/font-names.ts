// The other names the installed fonts go by. A font made for Korean, Japanese
// or Chinese has its name in that language too (맑은 고딕 for Malgun Gothic),
// which CSS takes like the English one; but Chromium lists the fonts by their
// English names only (queryLocalFonts), so the settings' font fields could not
// find one by the name its users know it by. The system says them:
//
// - Windows: WPF, through Windows PowerShell — every name of every family, in
//   each language it has one for. Some 0.3 s, once.
// - Linux: fontconfig (fc-list), one name per language.
// - macOS: none read; a name typed whole is still taken when the browser has
//   the font (FontCombobox).

import { execFile } from "node:child_process";
import path from "node:path";

/** Each family's names, for those with more than one; read once. */
let reading: Promise<string[][]> | null = null;

/** The families that go by more than one name, each as its names. */
export function fontNames(): Promise<string[][]> {
  reading ??= readFontNames().catch(() => []);
  return reading;
}

async function readFontNames(): Promise<string[][]> {
  if (process.platform === "win32") {
    return parseNameLines(await run(windowsPowerShell(), POWERSHELL_ARGS, WINDOWS_SCRIPT));
  }
  if (process.platform === "linux") {
    return parseFcList(await run("fc-list", ["--format", "%{family}\\t%{familylang}\\n"]));
  }
  return [];
}

// One statement a line: PowerShell runs what it reads on stdin line by line.
const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName PresentationCore",
  "$families = @([Windows.Media.Fonts]::SystemFontFamilies)",
  // Fonts installed for this user only, as Windows installs them without an
  // administrator; the system's list may leave them out.
  "if ($env:LOCALAPPDATA) { $user = Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts\\'; if (Test-Path $user) { $families += @([Windows.Media.Fonts]::GetFontFamilies($user)) } }",
  'foreach ($f in $families) { @($f.FamilyNames.Values | Select-Object -Unique) -join "`t" }',
  "",
].join("\n");

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "-"];

function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function run(program: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 8 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(input ?? "");
  });
}

/**
 * A family's names, a line each, tab between: those with two or more names
 * apart from case, each family once (it may be in both the system's list and
 * the user's).
 */
export function parseNameLines(text: string): string[][] {
  const groups = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const names = distinctNames(line.split("\t"));
    if (names.length > 1) groups.set(names.join("\t").toLowerCase(), names);
  }
  return [...groups.values()];
}

/**
 * fc-list's "families<TAB>languages", each a comma list in the same order:
 * the first name in each language, for families with names in two or more.
 * Further names in a language are the family's styles ("Noto Sans CJK JP
 * Black"), not other names for it.
 */
export function parseFcList(text: string): string[][] {
  const groups = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const [familyList = "", langList = ""] = line.split("\t");
    const families = familyList.split(",");
    const langs = langList.split(",");
    const byLang = new Map<string, string>();
    families.forEach((family, i) => {
      const lang = langs[i] ?? "";
      if (!byLang.has(lang)) byLang.set(lang, family);
    });
    const names = distinctNames([...byLang.values()]);
    // Each style of a family is a line of its own.
    if (names.length > 1) groups.set(names.join("\t").toLowerCase(), names);
  }
  return [...groups.values()];
}

function distinctNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
