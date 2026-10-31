/**
 * Quotes text as one argument of a command typed into the terminal's shell.
 * `shellPath` is the local shell main reported; a remote terminal has none
 * and gets POSIX quoting.
 *
 * - PowerShell: single quotes, with any single quote doubled.
 * - cmd.exe: double quotes, with any double quote doubled, which programs
 *   read back as one. cmd still expands `%NAME%` of a defined variable.
 * - Any other shell: single quotes, with a single quote written as `'\''`.
 *
 * Line breaks become spaces: typed into a shell, they would run the line.
 */
export function quoteShellArgument(text: string, shellPath?: string): string {
  const oneLine = text.replace(/[\r\n]+/g, " ");
  const shell = shellPath?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (shell === "powershell.exe" || shell === "pwsh.exe" || shell === "pwsh") {
    // PowerShell also takes the typographic single quotes as quotes.
    return `'${oneLine.replace(/['‘’‚‛]/g, "$&$&")}'`;
  }
  if (shell === "cmd.exe") return `"${oneLine.replaceAll('"', '""')}"`;
  return `'${oneLine.replaceAll("'", "'\\''")}'`;
}
