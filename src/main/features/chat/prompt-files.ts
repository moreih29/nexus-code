// The merged system prompt of a Claude tab, written to a file for claude's
// `--append-system-prompt-file` where the command line has no room for it
// (Windows: 32,767 UTF-16 units once every quote is escaped). The text is the
// user's own instructions: it is not logged, and neither is the file's path.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../../shared/log/main";
import { ensureDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("chat-prompt-files");

/** Writes and removes a tab's prompt files; a path is only to be passed on and forgotten. */
export interface PromptFiles {
  /** Writes `text` (UTF-8 without a BOM, unchanged) to a new file for the tab; its path. */
  write(tabId: string, text: string): Promise<string>;
  remove(file: string): Promise<void>;
}

/** The directory of the prompt files, under the app's runtime directory. */
export function promptFilesDir(): string {
  return path.join(root(), "run", "claude-prompts");
}

/**
 * Prompt files under `dir`. Files an earlier run left are removed first;
 * `write` waits for that, so a new file is never swept away with them.
 */
export function createPromptFiles(dir: string = promptFilesDir()): PromptFiles {
  const swept = fs.rm(dir, { recursive: true, force: true }).catch(() => {
    log.warn("old instructions files could not be removed");
  });
  return {
    async write(tabId, text) {
      await swept;
      await ensureDir(dir);
      const name = `${tabId.replace(/[^A-Za-z0-9_-]/g, "_")}-${randomUUID()}.txt`;
      const file = path.join(dir, name);
      await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
      return file;
    },
    async remove(file) {
      await fs.rm(file, { force: true }).catch(() => {
        log.warn("an instructions file could not be removed");
      });
    },
  };
}
