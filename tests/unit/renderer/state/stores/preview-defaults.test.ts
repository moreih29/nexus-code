/**
 * The view each format with a preview opens in: a format this version does
 * not know is dropped on load.
 */

import { describe, expect, it } from "bun:test";
import { usePreviewDefaultsStore } from "../../../../../src/renderer/state/stores/preview-defaults";

describe("usePreviewDefaultsStore", () => {
  it("drops a format it does not know on load", () => {
    usePreviewDefaultsStore.getState().hydrate({ json: "preview", future: "raw" });
    expect(usePreviewDefaultsStore.getState().byFormat).toEqual({ json: "preview" });
  });
});
