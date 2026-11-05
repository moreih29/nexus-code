import { describe, expect, it } from "bun:test";
import { isFontFile } from "../../../../../src/renderer/services/editor/preview/font";

describe("isFontFile", () => {
  it("takes the web font formats, case aside", () => {
    for (const name of ["a.ttf", "a.OTF", "a.woff", "a.woff2"]) {
      expect(isFontFile(`/w/fonts/${name}`)).toBe(true);
    }
  });

  it("leaves other files, and formats the browser does not load", () => {
    for (const name of ["a.eot", "a.ttc", "fonts.css", "woff2"]) {
      expect(isFontFile(`/w/${name}`)).toBe(false);
    }
  });
});
