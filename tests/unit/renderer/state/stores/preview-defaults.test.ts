import { afterEach, describe, expect, it } from "bun:test";
import { usePreviewDefaultsStore } from "../../../../../src/renderer/state/stores/preview-defaults";

describe("usePreviewDefaultsStore", () => {
  afterEach(() => {
    usePreviewDefaultsStore.getState().hydrate({});
  });

  it("drops a format it does not know on load", () => {
    usePreviewDefaultsStore.getState().hydrate({ json: "preview", future: "raw" });
    expect(usePreviewDefaultsStore.getState().byFormat).toEqual({ json: "preview" });
  });
});
