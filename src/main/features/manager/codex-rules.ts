/**
 * The Codex rules of the manager's folder. The manager drives the app with
 * `nexus`, which reaches it over a local socket, and Codex's sandbox denies
 * that connection. A rule in the folder's .codex/rules, which Codex reads
 * as its project's, lets `nexus` run outside the sandbox without asking, as
 * Claude's manager runs it with --allowedTools; its other commands stay as
 * the user's Codex settings say. Codex reads a project's rules only when it
 * trusts the project: the manager's codex trusts the folder for its session
 * (chat/launch.ts, codexAppServerArgs).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANAGER_CODEX_RULES = `# Written by NexusCode for its agent manager, at each start.
prefix_rule(pattern = ["nexus"], decision = "allow")
`;

/** Writes the rules into `dir`, the manager's folder, unless they are there already. */
export async function writeManagerCodexRules(dir: string): Promise<void> {
  const file = path.join(dir, ".codex", "rules", "nexus.rules");
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === MANAGER_CODEX_RULES) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, MANAGER_CODEX_RULES);
}
