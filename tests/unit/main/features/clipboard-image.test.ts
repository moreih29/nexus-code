/**
 * writeImageHandler — puts a quick look's image, a PNG data URL, on the
 * clipboard; anything but a PNG data URL is refused before it gets there.
 */

import { describe, expect, test } from "bun:test";
import { writeImageHandler } from "../../../../src/main/features/clipboard/ipc";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("writeImageHandler", () => {
  test("writes the PNG data URL it is given", async () => {
    const written: string[] = [];
    const handler = writeImageHandler({
      writePng: async (dataUrl) => {
        written.push(dataUrl);
      },
    });
    expect(await handler({ pngDataUrl: PNG })).toEqual({ ok: true });
    expect(written).toEqual([PNG]);
  });

  test("refuses what is not a PNG data URL", async () => {
    const written: string[] = [];
    const handler = writeImageHandler({
      writePng: async (dataUrl) => {
        written.push(dataUrl);
      },
    });
    await expect(handler({ pngDataUrl: "data:image/jpeg;base64,/9j/" })).rejects.toThrow();
    await expect(handler({ pngDataUrl: "https://example.com/a.png" })).rejects.toThrow();
    expect(written).toEqual([]);
  });

  test("passes on the clipboard's failure", async () => {
    const handler = writeImageHandler({
      writePng: async () => {
        throw new Error("the data is not an image");
      },
    });
    await expect(handler({ pngDataUrl: PNG })).rejects.toThrow("the data is not an image");
  });
});
