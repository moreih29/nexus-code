import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  highlightCode,
  languageOf,
} from "../../../../../src/renderer/components/chat/code-highlight";
import { numberedLines } from "../../../../../src/renderer/components/chat/tool-row";

const markup = (code: string, language: string | undefined) =>
  renderToStaticMarkup(createElement(Fragment, null, highlightCode(code, language)));

describe("languageOf", () => {
  test("knows a file's language by its extension or name", () => {
    expect(languageOf("/w/src/a.ts")).toBe("ts");
    expect(languageOf("C:\\w\\main.go")).toBe("go");
    expect(languageOf("/w/config.YML")).toBe("yml");
    expect(languageOf("/w/Dockerfile")).toBe("dockerfile");
  });

  test("leaves files it has no grammar for plain", () => {
    expect(languageOf("/w/data.xyz")).toBeUndefined();
    expect(languageOf("/w/.env")).toBeUndefined();
    expect(languageOf("/w/LICENSE")).toBeUndefined();
  });
});

describe("highlightCode", () => {
  test("wraps tokens in highlight.js classes", () => {
    const html = markup('return "hi";', "ts");
    expect(html).toContain('<span class="hljs-keyword">return</span>');
    expect(html).toContain('<span class="hljs-string">&quot;hi&quot;</span>');
  });

  test("gives the text back as it is with no language", () => {
    expect(highlightCode("a < b", undefined)).toBe("a < b");
    expect(highlightCode("a < b", "no-such-language")).toBe("a < b");
  });
});

describe("numberedLines", () => {
  test("splits a Read result's numbers from its code", () => {
    expect(numberedLines("1\tconst a = 1;\n2\t\n3\t}\n")).toEqual({
      numbers: ["1", "2", "3"],
      code: "const a = 1;\n\n}",
    });
  });

  test("reads the arrow form of older versions", () => {
    expect(numberedLines("    9→x\n   10→y")).toEqual({ numbers: ["9", "10"], code: "x\ny" });
  });

  test("is null for text that is not all numbered lines", () => {
    expect(numberedLines("File does not exist.")).toBeNull();
    expect(numberedLines("1\tok\nnot numbered")).toBeNull();
    expect(numberedLines("")).toBeNull();
  });
});
