import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const CODESIGN = "/usr/bin/codesign";
export const CODESIGN_TIMEOUTS_MS = [5_000, 15_000] as const;

export type RunCodesign = (args: string[], timeoutMs: number) => Promise<string>;

const runCodesign: RunCodesign = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(CODESIGN, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    });
  });

export function bundleOf(executable: string): string {
  const bundle = dirname(dirname(dirname(executable)));
  return bundle.endsWith(".app") ? bundle : executable;
}

export function designatedRequirement(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^(?:#\s*)?designated\s*=>\s*(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export async function appSignature(
  executable = process.execPath,
  run: RunCodesign = runCodesign,
): Promise<string | null> {
  const args = ["-d", "-r-", bundleOf(executable)];
  for (const timeoutMs of CODESIGN_TIMEOUTS_MS) {
    let output: string;
    try {
      output = await run(args, timeoutMs);
    } catch {
      continue;
    }
    const requirement = designatedRequirement(output);
    return requirement ? createHash("sha256").update(requirement).digest("hex") : null;
  }
  return null;
}
