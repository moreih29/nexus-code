import { execFile } from "node:child_process";
import path from "node:path";

let reading: Promise<string[][]> | null = null;

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

const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName PresentationCore",
  "$families = @([Windows.Media.Fonts]::SystemFontFamilies)",
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

export function parseNameLines(text: string): string[][] {
  const groups = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const names = distinctNames(line.split("\t"));
    if (names.length > 1) groups.set(names.join("\t").toLowerCase(), names);
  }
  return [...groups.values()];
}

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
