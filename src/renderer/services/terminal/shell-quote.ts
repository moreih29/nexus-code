/**
 * Quotes text as one argument of a command typed into the terminal's shell.
 * `shellPath` is the local shell main reported; a remote terminal has none
 * and gets POSIX quoting.
 *
 * - PowerShell 7 (pwsh): single quotes, with any single quote doubled.
 * - Windows PowerShell (powershell.exe): the same, with the text escaped for
 *   the program's command line too. Windows PowerShell hands an argument to
 *   a program wrapped in double quotes without escaping the ones inside, so
 *   `fix the "login redirect" bug` would reach `claude` as two arguments
 *   without their quotes. A PowerShell command such as `echo` shows the
 *   backslashes this adds.
 * - cmd.exe: double quotes, with any double quote doubled, which programs
 *   read back as one. cmd still expands `%NAME%` of a defined variable.
 * - Any other shell: single quotes, with a single quote written as `'\''`.
 *
 * Line breaks become spaces: typed into a shell, they would run the line.
 */
export function quoteShellArgument(text: string, shellPath?: string): string {
  const oneLine = text.replace(/[\r\n]+/g, " ");
  const shell = shellPath?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (shell === "powershell.exe") return powerShellString(escapeForCommandLine(oneLine));
  if (shell === "pwsh.exe" || shell === "pwsh") return powerShellString(oneLine);
  if (shell === "cmd.exe") return `"${oneLine.replaceAll('"', '""')}"`;
  return `'${oneLine.replaceAll("'", "'\\''")}'`;
}

/** A single-quoted PowerShell string, which also takes the typographic single quotes as quotes. */
function powerShellString(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/** What .NET's Char.IsWhiteSpace counts, which Windows PowerShell checks. */
const DOTNET_WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/**
 * Escapes text as a Windows program reads its command line back: a double
 * quote takes a backslash, and the backslashes before it are doubled.
 * Windows PowerShell wraps an argument with whitespace in double quotes, so
 * then the backslashes at the end are doubled too, or the last one would
 * escape the closing quote.
 */
function escapeForCommandLine(text: string): string {
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"');
  return DOTNET_WHITESPACE.test(escaped) ? escaped.replace(/(\\+)$/, "$1$1") : escaped;
}
