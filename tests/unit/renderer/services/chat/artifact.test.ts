/**
 * The pages Claude publishes to claude.ai with its Artifact tool, as a
 * conversation shows them: from a finished publish of an HTML or Markdown
 * file, with the page's link the result gives, named by the call, the
 * document's title or the file.
 */

import { describe, expect, it } from "bun:test";
import {
  artifactName,
  artifactOf,
  artifactsOf,
  isHtmlPage,
  titleOfHtml,
} from "../../../../../src/renderer/services/chat/artifact";
import type { ToolCall } from "../../../../../src/renderer/services/chat/model";

const URL_A = "https://claude.ai/code/artifact/7c1e9a42-5b3d-4e8f-9a1c-2d4e6f8a0b1c";
const URL_B = "https://claude.ai/artifact/b9f0";

function publish(
  id: string,
  input: Record<string, unknown>,
  result = `Published report.html\n${URL_A}\nPrivate by default.`,
  over: Partial<ToolCall> = {},
): ToolCall {
  return {
    id,
    name: "Artifact",
    input,
    status: "done",
    result: { text: result, isError: false, images: [] },
    parentToolUseId: null,
    ...over,
  };
}

describe("artifactOf", () => {
  it("takes a finished publish's file, its page's link, and what the call said of it", () => {
    const tool = publish("t1", {
      file_path: "/tmp/s/report.html",
      icon: "chart",
      description: "This week's sales",
    });
    expect(artifactOf(tool, "/w")).toEqual({
      toolUseId: "t1",
      file: "/tmp/s/report.html",
      url: URL_A,
      description: "This week's sales",
      update: false,
    });
  });

  it("finds a file the call named from the session's folder", () => {
    expect(artifactOf(publish("t1", { file_path: "out/report.html" }), "/w")?.file).toBe(
      "/w/out/report.html",
    );
  });

  it("knows an update of a page published before, by the link it was given", () => {
    const tool = publish(
      "t1",
      { file_path: "/w/report.html", url: URL_B, title: "Sales" },
      "Updated.",
    );
    expect(artifactOf(tool, "/w")).toMatchObject({ url: URL_B, title: "Sales", update: true });
  });

  it("is no page for the tool's other calls, or one not done well", () => {
    const page = { file_path: "/w/report.html" };
    expect(artifactOf(publish("t", { ...page, action: "read" }), "/w")).toBeNull();
    expect(
      artifactOf(publish("t", { url: URL_A, file_path: "/w/a.png", asset: true }), "/w"),
    ).toBeNull();
    expect(artifactOf(publish("t", { file_path: "/w/data.json" }), "/w")).toBeNull();
    expect(artifactOf(publish("t", page, "", { status: "running" }), "/w")).toBeNull();
    expect(
      artifactOf(
        publish("t", page, "", { result: { text: "Refused", isError: true, images: [] } }),
        "/w",
      ),
    ).toBeNull();
    expect(artifactOf({ ...publish("t", page), name: "Write" }, "/w")).toBeNull();
    expect(artifactOf(undefined, "/w")).toBeNull();
  });

  it("takes a Markdown page, which has no thumbnail", () => {
    const page = artifactOf(publish("t1", { file_path: "/w/notes.md" }), "/w");
    expect(page?.file).toBe("/w/notes.md");
    expect(page && isHtmlPage(page)).toBe(false);
  });
});

describe("artifactsOf", () => {
  it("lists each page once, as it was last published, in order", () => {
    const tools = {
      a: publish("a", { file_path: "/w/one.html", description: "first" }),
      b: publish("b", { file_path: "/w/two.html" }, `Published\n${URL_B}`),
      c: publish("c", { file_path: "/w/one.html", url: URL_A, description: "again" }),
      d: { ...publish("d", { file_path: "/w/x.html" }), name: "Read" },
    };
    expect(artifactsOf(tools, "/w").map((page) => [page.toolUseId, page.description])).toEqual([
      ["b", undefined],
      ["c", "again"],
    ]);
  });
});

describe("titleOfHtml", () => {
  it("reads the document's title, its entities undone and its spaces made one", () => {
    expect(titleOfHtml("<head><title>\n  Sales &amp; orders  </title></head>")).toBe(
      "Sales & orders",
    );
    expect(titleOfHtml('<TITLE lang="ko">주간 매출</TITLE>')).toBe("주간 매출");
  });

  it("is null for a document with no title, or an empty one", () => {
    expect(titleOfHtml("<html><body>hi</body></html>")).toBeNull();
    expect(titleOfHtml("<title> </title>")).toBeNull();
  });
});

describe("artifactName", () => {
  const page = artifactOf(publish("t", { file_path: "/w/sales-dashboard.html" }), "/w");

  it("is the call's name, else the document's title, else the file's", () => {
    if (!page) throw new Error("no page");
    expect(artifactName({ ...page, title: "Given" }, "Titled")).toBe("Given");
    expect(artifactName(page, "Titled")).toBe("Titled");
    expect(artifactName(page, null)).toBe("sales-dashboard");
  });
});
