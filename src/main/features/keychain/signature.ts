import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const CODESIGN = "/usr/bin/codesign";
const TIMEOUT_MS = 5000;

export type RunCodesign = (args: string[]) => Promise<string>;

const runCodesign: RunCodesign = (args) =>
  new Promise((resolve, reject) => {
    execFile(CODESIGN, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
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
  try {
    const requirement = designatedRequirement(await run(["-d", "-r-", bundleOf(executable)]));
    return requirement ? createHash("sha256").update(requirement).digest("hex") : null;
  } catch {
    return null;
  }
}
