import { posixShellString, powerShellString } from "../../../shared/pty/shell";

export function quoteShellArgument(text: string, shellPath?: string): string {
  const oneLine = text.replace(/[\r\n]+/g, " ");
  const shell = shellPath?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (shell === "powershell.exe") return powerShellString(escapeForCommandLine(oneLine));
  if (shell === "pwsh.exe" || shell === "pwsh") return powerShellString(oneLine);
  if (shell === "cmd.exe") return cmdString(oneLine);
  return posixShellString(oneLine);
}

function cmdString(text: string): string {
  return text
    .split("%")
    .map((part) => `"${part.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`)
    .join("^%");
}

const DOTNET_WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function escapeForCommandLine(text: string): string {
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"');
  return DOTNET_WHITESPACE.test(escaped) ? escaped.replace(/(\\+)$/, "$1$1") : escaped;
}
