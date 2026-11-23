import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";

const writeTextArgsSchema = ipcContract.clipboard.call.writeText.args;
const writeImageArgsSchema = ipcContract.clipboard.call.writeImage.args;

export interface ClipboardImpl {
  writeText(text: string): Promise<void> | void;
}

export interface ImageClipboardImpl {
  writePng(dataUrl: string): Promise<void>;
}

export function getElectronClipboard(): ClipboardImpl {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clipboard } = require("electron") as typeof import("electron");
  return clipboard;
}

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
