import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../../shared/log/main";
import { ensureDir, root } from "../../infra/agent/runtimeDirs";

const log = createLogger("chat-prompt-files");

export interface PromptFiles {
  write(tabId: string, text: string): Promise<string>;
  remove(file: string): Promise<void>;
}

export function promptFilesDir(): string {
  return path.join(root(), "run", "claude-prompts");
}

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
