import { z } from "zod";

export const CustomShellSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  args: z.array(z.string().max(1024)).max(64),
});
export type CustomShell = z.infer<typeof CustomShellSchema>;

export const ShellChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("detected"), id: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("custom"), id: z.string().min(1).max(64) }),
]);
export type ShellChoice = z.infer<typeof ShellChoiceSchema>;

export function sameShellChoice(a: ShellChoice | undefined, b: ShellChoice | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id;
}

export const ShellInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  args: z.array(z.string()),
});
export type ShellInfo = z.infer<typeof ShellInfoSchema>;

export function splitShellArgs(text: string): string[] {
  const args: string[] = [];
  let arg: string | null = null;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '"') {
      arg ??= "";
      if (quoted && text.charAt(i + 1) === '"') {
        arg += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && /\s/.test(char)) {
      if (arg !== null) args.push(arg);
      arg = null;
    } else {
      arg = (arg ?? "") + char;
    }
  }
  if (arg !== null) args.push(arg);
  return args;
}

export function joinShellArgs(args: readonly string[]): string {
  return args
    .map((arg) => (/[\s"]/.test(arg) || arg === "" ? `"${arg.replaceAll('"', '""')}"` : arg))
    .join(" ");
}

export function posixShellString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function powerShellString(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}
