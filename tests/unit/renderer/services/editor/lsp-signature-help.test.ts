/**
 * LSP signature help as Monaco shows it, and what Monaco shows handed back
 * to the server as it asks again.
 */

import { expect, test } from "bun:test";
import {
  lspSignatureHelpToMonaco,
  monacoSignatureHelpToLsp,
} from "../../../../../src/renderer/services/editor/lsp/monaco-converters";

test("a signature keeps its parameters, plain and markdown documentation", () => {
  const help = lspSignatureHelpToMonaco({
    signatures: [
      {
        label: "get(url: str, params: dict | None = None) -> Response",
        documentation: { kind: "markdown", value: "Sends a **GET** request." },
        parameters: [
          { label: [4, 12] },
          { label: "params: dict | None = None", documentation: "Query *string*." },
        ],
      },
    ],
    activeSignature: 0,
    activeParameter: 1,
  });

  expect(help).toEqual({
    signatures: [
      {
        label: "get(url: str, params: dict | None = None) -> Response",
        documentation: { value: "Sends a **GET** request." },
        parameters: [
          { label: [4, 12], documentation: undefined },
          // A plain string stays plain text.
          { label: "params: dict | None = None", documentation: "Query *string*." },
        ],
      },
    ],
    activeSignature: 0,
    activeParameter: 1,
  });
});

test("no parameter being typed highlights none; one left out is the first", () => {
  const none = lspSignatureHelpToMonaco({
    signatures: [{ label: "f()", activeParameter: null }],
    activeParameter: null,
  });
  expect(none.activeParameter).toBe(-1);
  expect(none.signatures[0]?.activeParameter).toBe(-1);

  const unset = lspSignatureHelpToMonaco({ signatures: [{ label: "f(a)" }] });
  expect(unset.activeSignature).toBe(0);
  expect(unset.activeParameter).toBe(0);
  expect(unset.signatures[0]).not.toHaveProperty("activeParameter");
});

test("what is shown goes back with the picked overload and no documentation", () => {
  expect(
    monacoSignatureHelpToLsp({
      signatures: [
        { label: "f(a)", documentation: "One.", parameters: [{ label: "a" }] },
        { label: "f(a, b)", parameters: [{ label: "a" }, { label: [5, 6] }], activeParameter: -1 },
      ],
      activeSignature: 1,
      activeParameter: -1,
    }),
  ).toEqual({
    signatures: [
      { label: "f(a)", parameters: [{ label: "a" }] },
      { label: "f(a, b)", parameters: [{ label: "a" }, { label: [5, 6] }] },
    ],
    activeSignature: 1,
    activeParameter: null,
  });
  expect(
    monacoSignatureHelpToLsp({ signatures: [], activeSignature: 0, activeParameter: 0 }),
  ).toBeUndefined();
});
