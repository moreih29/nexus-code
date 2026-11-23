/**
 * The running app's signature as the keychain tells apps apart.
 *
 * A keychain item's access list keeps, for each app it trusts, the app's
 * designated requirement (DR): the code requirement the app's signature
 * states it is to be known by. The item lets an app in without asking when
 * it meets one of those, so a DR that changed (another certificate, another
 * team, ad hoc to signed) is what makes macOS ask. The DR is taken from the
 * bundle with codesign, and kept as its hash.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const CODESIGN = "/usr/bin/codesign";
const TIMEOUT_MS = 5000;

export type RunCodesign = (args: string[]) => Promise<string>;

/** codesign's output, stdout then stderr: where the DR line goes has varied. */
const runCodesign: RunCodesign = (args) =>
  new Promise((resolve, reject) => {
    execFile(CODESIGN, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    });
  });

/** The .app bundle an executable is in (Contents/MacOS/<name>), or the executable itself. */
export function bundleOf(executable: string): string {
  const bundle = dirname(dirname(dirname(executable)));
  return bundle.endsWith(".app") ? bundle : executable;
}

/** The designated requirement in `codesign -d -r-`'s output: "designated => …", "# " first when implied. */
export function designatedRequirement(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^(?:#\s*)?designated\s*=>\s*(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/** The hash of the running app's DR; null where it is unsigned or codesign cannot tell. */
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
