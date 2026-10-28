import { describe, expect, test } from "bun:test";
import { writeTextHandler } from "../../../../../src/main/features/clipboard/ipc";

describe("clipboard.writeText", () => {
  test("answers once the clipboard holds the text", async () => {
    const written: string[] = [];
    let finish: () => void = () => {};
    const handler = writeTextHandler({
      writeText: (text) =>
        new Promise<void>((resolve) => {
          finish = () => {
            written.push(text);
            resolve();
          };
        }),
    });

    let answered = false;
    const reply = handler({ text: "copied" }).then((result) => {
      answered = true;
      return result;
    });
    await Promise.resolve();
    expect(answered).toBe(false);

    finish();
    expect(await reply).toEqual({ ok: true });
    expect(written).toEqual(["copied"]);
  });

  test("passes on a failed write instead of answering ok", async () => {
    const handler = writeTextHandler({
      writeText: async () => {
        throw new Error("clipboard busy");
      },
    });

    await expect(handler({ text: "copied" })).rejects.toThrow("clipboard busy");
  });
});
