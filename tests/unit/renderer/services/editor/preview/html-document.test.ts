import { describe, expect, test } from "bun:test";
import {
  buildPreviewDocument,
  leadingDoctypeEnd,
  STANDARD_DOCTYPE,
} from "../../../../../../src/renderer/services/editor/preview/html-document";

const HEAD = "<base href=x>";
const BOM = String.fromCharCode(0xfeff);

describe("leadingDoctypeEnd", () => {
  test("finds the DOCTYPE that opens a page, past whitespace and comments", () => {
    expect(leadingDoctypeEnd("<!DOCTYPE html><p>")).toBe(15);
    expect(leadingDoctypeEnd("<!doctype html>")).toBe(15);
    const page = [BOM, "  <!-- a --><!-- b -->", "<!DocType html>"].join("\n");
    expect(leadingDoctypeEnd(`${page}<p>`)).toBe(page.length);
  });

  test("finds none when something else opens the page", () => {
    expect(leadingDoctypeEnd("<html><!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("text <!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("<!-- never closed <!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("")).toBe(-1);
  });
});

describe("buildPreviewDocument", () => {
  test("puts the head right after the page's <head> tag", () => {
    const page = '<!DOCTYPE html><html><head lang="en"><title>t</title>';
    expect(buildPreviewDocument(page, HEAD)).toBe(
      `<!DOCTYPE html><html><head lang="en">${HEAD}<title>t</title>`,
    );
  });

  test("gives a page without a DOCTYPE the standard one, as srcdoc rendered it", () => {
    expect(buildPreviewDocument("<html><head></head><body>x", HEAD)).toBe(
      `${STANDARD_DOCTYPE}<html><head>${HEAD}</head><body>x`,
    );
    expect(buildPreviewDocument("<p>x</p>", HEAD)).toBe(`${STANDARD_DOCTYPE}${HEAD}<p>x</p>`);
  });

  test("keeps a page's own DOCTYPE first when it has no <head> tag", () => {
    expect(buildPreviewDocument("<!-- c --><!doctype html><title>t</title>", HEAD)).toBe(
      `<!-- c --><!doctype html>${HEAD}<title>t</title>`,
    );
  });

  test("does not take a <header> for the head", () => {
    expect(buildPreviewDocument("<!DOCTYPE html><header>h</header>", HEAD)).toBe(
      `<!DOCTYPE html>${HEAD}<header>h</header>`,
    );
  });
});
