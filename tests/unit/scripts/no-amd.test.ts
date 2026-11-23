import { expect, test } from "bun:test";
import { withoutAmdCheck } from "../../../scripts/no-amd";

test("a UMD define.amd check is turned off", () => {
  expect(withoutAmdCheck('if (typeof define === "function" && define.amd) define([], f);')).toBe(
    "if (false && false) define([], f);",
  );
  expect(withoutAmdCheck('"function"==typeof define&&define.amd?define(f):g()')).toBe(
    "false&&false?define(f):g()",
  );
});

test("fastdom's plain function check is turned off, so it exports through module", () => {
  const core = `if (typeof define == "function") define(function() {
  return exports2;
});
else if (typeof module == "object") module.exports = exports2;`;
  const out = withoutAmdCheck(core);
  expect(out).toContain("if (false) define(function()");
  expect(out).toContain('typeof module == "object"');
});

test("fastdom's typeof-first-letter check is turned off, so Monaco's AMD loader is not called", () => {
  const fastdom = `if ((typeof define)[0] == "f") define(function() {
  return exports2;
});
else if ((typeof module)[0] == "o") module.exports = exports2;`;
  const out = withoutAmdCheck(fastdom);
  expect(out).toContain("if (false) define(function()");
  expect(out).toContain('(typeof module)[0] == "o"');
});

test("an assignment to define.amd and code without define are left alone", () => {
  expect(withoutAmdCheck("define.amd = {};")).toBeNull();
  expect(withoutAmdCheck("const a = 1;")).toBeNull();
});
