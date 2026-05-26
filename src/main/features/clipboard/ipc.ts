/**
 * clipboard channel — system clipboard write via the main process.
 *
 * Renderer-side `navigator.clipboard.writeText` requires transient user
 * activation (Chromium Async Clipboard API), so non-gesture call sites
 * — OSC 52 sequences from a TUI, drag-selection in xterm — silently reject.
 * Electron's main-process `clipboard.writeText` has no activation gate.
 *
 * Read is deliberately not exposed: letting renderer or TUI code read the
 * system clipboard is a privacy risk. Write-only mirrors `browser/security`
 * which already grants only `clipboard-sanitized-write` to embedded browsers.
 */

import { ipcContract } from "../../../shared/ipc/contract";
import { register } from "../../infra/ipc-router";
import { validateArgs } from "../../infra/ipc-router";

const writeTextArgsSchema = ipcContract.clipboard.call.writeText.args;

export interface ClipboardImpl {
  writeText(text: string): void;
}

/**
 * Lazily reads Electron's clipboard module so unit tests can import this file
 * and inject a stub without evaluating Electron at module load time. Matches
 * the lazy-require pattern in `shell/open-path.ts`.
 */
export function getElectronClipboard(): ClipboardImpl {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clipboard } = require("electron") as typeof import("electron");
  return clipboard;
}

export function writeTextHandler(
  clipboardImpl: ClipboardImpl = getElectronClipboard(),
): (args: unknown) => Promise<{ ok: true }> {
  return async (args: unknown) => {
    const { text } = validateArgs(writeTextArgsSchema, args);
    clipboardImpl.writeText(text);
    return { ok: true };
  };
}

export function registerClipboardChannel(): void {
  register("clipboard", {
    call: {
      writeText: writeTextHandler(),
    },
    listen: {},
  });
}
