import { describe, expect, it } from "bun:test";
import { evaluateWhen, parseWhen } from "../../../src/shared/keybinding-when";

function ev(expr: string, ctx: Record<string, boolean>): boolean {
  return evaluateWhen(parseWhen(expr), (name) => ctx[name] === true);
}

describe("parseWhen / evaluateWhen", () => {
  it("evaluates a single key", () => {
    expect(ev("editorFocus", { editorFocus: true })).toBe(true);
    expect(ev("editorFocus", { editorFocus: false })).toBe(false);
    expect(ev("editorFocus", {})).toBe(false);
  });

  it("evaluates negation", () => {
    expect(ev("!inputFocus", { inputFocus: false })).toBe(true);
    expect(ev("!inputFocus", { inputFocus: true })).toBe(false);
  });

  it("evaluates double negation", () => {
    expect(ev("!!editorFocus", { editorFocus: true })).toBe(true);
    expect(ev("!!editorFocus", { editorFocus: false })).toBe(false);
  });

  it("evaluates AND", () => {
    expect(ev("a && b", { a: true, b: true })).toBe(true);
    expect(ev("a && b", { a: true, b: false })).toBe(false);
    expect(ev("a && b", { a: false, b: true })).toBe(false);
  });

  it("evaluates OR", () => {
    expect(ev("a || b", { a: false, b: false })).toBe(false);
    expect(ev("a || b", { a: true, b: false })).toBe(true);
    expect(ev("a || b", { a: false, b: true })).toBe(true);
  });

  it("respects AND precedence over OR (a || b && c)", () => {
    // a || (b && c)
    expect(ev("a || b && c", { a: false, b: true, c: true })).toBe(true);
    expect(ev("a || b && c", { a: false, b: true, c: false })).toBe(false);
    expect(ev("a || b && c", { a: true, b: false, c: false })).toBe(true);
  });

  it("respects parentheses to override precedence", () => {
    // (a || b) && c
    expect(ev("(a || b) && c", { a: true, b: false, c: false })).toBe(false);
    expect(ev("(a || b) && c", { a: true, b: false, c: true })).toBe(true);
  });

  it("handles whitespace", () => {
    expect(ev("  fileTreeFocus   &&  !inputFocus  ", { fileTreeFocus: true })).toBe(true);
  });

  it("supports dotted identifiers", () => {
    // VSCode uses keys like "editorTextFocus" but also "editorLangId == typescript".
    // We don't support comparison yet but dotted names are valid identifiers.
    expect(ev("ui.fileTree.focused", { "ui.fileTree.focused": true })).toBe(true);
  });

  it("throws on unmatched parenthesis", () => {
    expect(() => parseWhen("(a")).toThrow();
    expect(() => parseWhen("a)")).toThrow();
  });

  it("throws on unexpected operator", () => {
    expect(() => parseWhen("&& a")).toThrow();
    expect(() => parseWhen("a &&")).toThrow();
    expect(() => parseWhen("a || || b")).toThrow();
  });

  it("throws on unknown character", () => {
    expect(() => parseWhen("a == b")).toThrow();
  });
});
