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
import { register, validateArgs } from "../../infra/ipc-router";

const writeTextArgsSchema = ipcContract.clipboard.call.writeText.args;
const writeImageArgsSchema = ipcContract.clipboard.call.writeImage.args;

export interface ClipboardImpl {
  // Electron's resolves once the clipboard holds the text.
  writeText(text: string): Promise<void> | void;
}

export interface ImageClipboardImpl {
  /** Puts the image of a PNG data URL on the clipboard; rejects one that is not an image. */
  writePng(dataUrl: string): Promise<void>;
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

/** Electron's clipboard writing an image, read lazily as getElectronClipboard's. */
export function getElectronImageClipboard(): ImageClipboardImpl {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clipboard, ClipboardItem, nativeImage } =
    require("electron") as typeof import("electron");
  return {
    async writePng(dataUrl) {
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) throw new Error("the data is not an image");
      const png = new Blob([new Uint8Array(image.toPNG())], { type: "image/png" });
      await clipboard.write([new ClipboardItem({ "image/png": png })]);
    },
  };
}

export function writeImageHandler(
  clipboardImpl: ImageClipboardImpl = getElectronImageClipboard(),
): (args: unknown) => Promise<{ ok: true }> {
  return async (args: unknown) => {
    const { pngDataUrl } = validateArgs(writeImageArgsSchema, args);
    await clipboardImpl.writePng(pngDataUrl);
    return { ok: true };
  };
}

export function writeTextHandler(
  clipboardImpl: ClipboardImpl = getElectronClipboard(),
): (args: unknown) => Promise<{ ok: true }> {
  return async (args: unknown) => {
    const { text } = validateArgs(writeTextArgsSchema, args);
    await clipboardImpl.writeText(text);
    return { ok: true };
  };
}

export function registerClipboardChannel(): void {
  register("clipboard", {
    call: {
      writeText: writeTextHandler(),
      writeImage: writeImageHandler(),
    },
    listen: {},
  });
}
