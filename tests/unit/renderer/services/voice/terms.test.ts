import { describe, expect, test } from "bun:test";
import {
  addTerms,
  pastedTerms,
  removeTerm,
  splitTerms,
} from "../../../../../src/renderer/services/voice/terms";

describe("the terms the user types", () => {
  test("split at commas and line breaks, trimmed, the empty ones out", () => {
    expect(splitTerms("Soniox")).toEqual(["Soniox"]);
    expect(splitTerms(" Soniox ,  Tauri,,\nZustand\r\nbun ")).toEqual([
      "Soniox",
      "Tauri",
      "Zustand",
      "bun",
    ]);
    expect(splitTerms("깃허브，리액트、타입스크립트")).toEqual([
      "깃허브",
      "리액트",
      "타입스크립트",
    ]);
    expect(splitTerms(" , \n ")).toEqual([]);
  });

  test("a term keeps its inner spaces", () => {
    expect(splitTerms("Visual Studio Code, pull request")).toEqual([
      "Visual Studio Code",
      "pull request",
    ]);
  });
});

describe("adding terms to the list", () => {
  test("go after it, each once whatever its case", () => {
    expect(addTerms(["Soniox"], "tauri, SONIOX, Tauri, bun")).toEqual({
      status: "ok",
      terms: ["Soniox", "tauri", "bun"],
    });
  });

  test("nothing new is none", () => {
    expect(addTerms(["Soniox"], "  ")).toEqual({ status: "none" });
    expect(addTerms(["Soniox"], "soniox")).toEqual({ status: "none" });
  });

  test("a term over 80 characters adds nothing", () => {
    expect(addTerms([], `ok, ${"x".repeat(81)}`)).toEqual({ status: "too-long" });
    expect(addTerms([], "x".repeat(80))).toEqual({ status: "ok", terms: ["x".repeat(80)] });
  });

  test("more than 300 in all adds nothing", () => {
    const list = Array.from({ length: 299 }, (_, i) => `t${i}`);
    expect(addTerms(list, "a")).toMatchObject({ status: "ok" });
    expect(addTerms(list, "a, b")).toEqual({ status: "too-many" });
  });

  test("removing one leaves the rest in order", () => {
    expect(removeTerm(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(removeTerm(["a"], "z")).toEqual(["a"]);
  });
});

describe("a list pasted into the one-line field", () => {
  test("keeps each line a term of its own", () => {
    expect(pastedTerms("Soniox\nTauri\r\n\r\n bun \r")).toBe("Soniox, Tauri, bun");
    expect(splitTerms(pastedTerms("a\nb, c"))).toEqual(["a", "b", "c"]);
  });
});
