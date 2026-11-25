import { expect, test } from "bun:test";
import { nestedErrorText } from "../../../src/shared/util/nested-error-text";

class NamedError extends Error {
  override name = "SshError";
}

class UnnamedError extends Error {}

test.each([
  ["a plain Error", new Error("EPERM: locked"), "EPERM: locked"],
  ["a TypeError", new TypeError("x is not a function"), "TypeError: x is not a function"],
  ["a named subclass", new NamedError("auth failed"), "SshError: auth failed"],
  ["a subclass that keeps the Error name", new UnnamedError("exited (7)"), "exited (7)"],
  ["an Error with an empty name", Object.assign(new Error("bare"), { name: "" }), "bare"],
  ["an AggregateError", new AggregateError([], "both failed"), "AggregateError: both failed"],
  ["a string", "worker crashed", "worker crashed"],
  ["a number", 7, "7"],
  ["undefined", undefined, "undefined"],
  ["null", null, "null"],
])("renders %s once", (_label, error, text) => {
  expect(nestedErrorText(error)).toBe(text);
});

test("wrapping the text in a new Error names it once", () => {
  expect(String(new Error(nestedErrorText(new Error("EPERM: locked"))))).toBe(
    "Error: EPERM: locked",
  );
  expect(String(new Error(nestedErrorText(new TypeError("bad"))))).toBe("Error: TypeError: bad");
});
