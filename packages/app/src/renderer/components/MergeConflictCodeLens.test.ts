import { describe, expect, test } from "bun:test";

import {
  findMergeConflicts,
  findMergeConflictsInLines,
  registerMergeConflictCodeLensProvider,
  resolveMergeConflictLines,
} from "./MergeConflictCodeLens";

describe("MergeConflictCodeLens", () => {
  test("detects single and multiple strict merge conflict blocks", () => {
    expect(findMergeConflicts("<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> branch-a")).toEqual([
      { startLineNumber: 1, separatorLineNumber: 3, endLineNumber: 5 },
    ]);

    const text = [
      "one",
      "<<<<<<< HEAD",
      "current one",
      "=======",
      "incoming one",
      ">>>>>>> branch-a",
      "two",
      "<<<<<<< ours",
      "current two",
      "=======",
      "incoming two",
      ">>>>>>> theirs",
    ].join("\n");

    expect(findMergeConflicts(text)).toEqual([
      { startLineNumber: 2, separatorLineNumber: 4, endLineNumber: 6 },
      { startLineNumber: 8, separatorLineNumber: 10, endLineNumber: 12 },
    ]);
  });

  test("rejects loose conflict markers", () => {
    expect(findMergeConflicts("<<<<<<<HEAD\ncurrent\n=======\nincoming\n>>>>>>> branch")).toEqual([]);
    expect(findMergeConflicts("<<<<<<< HEAD\ncurrent\n======= incoming\nincoming\n>>>>>>> branch")).toEqual([]);
    expect(findMergeConflicts("<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>>branch")).toEqual([]);
  });

  test("resolves current, incoming, and both line content", () => {
    const lines = [
      "before",
      "<<<<<<< HEAD",
      "current A",
      "current B",
      "=======",
      "incoming A",
      ">>>>>>> branch-a",
      "after",
    ];
    const [conflict] = findMergeConflictsInLines(lines);

    expect(resolveMergeConflictLines(lines, conflict, "current")).toEqual([
      "before",
      "current A",
      "current B",
      "after",
    ]);
    expect(resolveMergeConflictLines(lines, conflict, "incoming")).toEqual([
      "before",
      "incoming A",
      "after",
    ]);
    expect(resolveMergeConflictLines(lines, conflict, "both")).toEqual([
      "before",
      "current A",
      "current B",
      "incoming A",
      "after",
    ]);
  });

  test("registers one idempotent CodeLensProvider and executes actions", () => {
    const monaco = createFakeMonaco();
    const model = createFakeModel(
      [
        "before",
        "<<<<<<< HEAD",
        "current",
        "=======",
        "incoming",
        ">>>>>>> branch-a",
        "after",
      ].join("\n"),
    );
    monaco.models.set(model.uri.toString(), model);

    const firstRegistration = registerMergeConflictCodeLensProvider(monaco);
    const secondRegistration = registerMergeConflictCodeLensProvider(monaco);

    expect(monaco.registerCodeLensProviderCalls).toBe(1);
    expect(monaco.registerCommandCalls).toBe(1);

    const codeLensList = monaco.codeLensProvider?.provideCodeLenses(model, {});
    expect(codeLensList?.lenses.map((lens) => lens.command?.title)).toEqual([
      "Accept Current",
      "Accept Incoming",
      "Accept Both",
    ]);

    const incomingLens = codeLensList?.lenses.find(
      (lens) => lens.command?.title === "Accept Incoming",
    );
    monaco.commands.get(incomingLens?.command?.id ?? "")?.(
      {},
      ...(incomingLens?.command?.arguments ?? []),
    );

    expect(model.text).toBe(["before", "incoming", "after"].join("\n"));

    firstRegistration.dispose();
    expect(monaco.providerDisposed).toBe(false);
    expect(monaco.commandDisposed).toBe(false);

    secondRegistration.dispose();
    expect(monaco.providerDisposed).toBe(true);
    expect(monaco.commandDisposed).toBe(true);
  });
});

function createFakeMonaco() {
  class Range {
    public constructor(
      public readonly startLineNumber: number,
      public readonly startColumn: number,
      public readonly endLineNumber: number,
      public readonly endColumn: number,
    ) {}
  }

  const monaco = {
    Range,
    Uri: {
      parse(value: string) {
        return { toString: () => value };
      },
    },
    commands: new Map<string, (accessor: unknown, ...args: unknown[]) => void>(),
    models: new Map<string, unknown>(),
    codeLensProvider: null as null | {
      provideCodeLenses(model: unknown, token: unknown): {
        lenses: Array<{
          command?: {
            id: string;
            title: string;
            arguments?: unknown[];
          };
        }>;
      };
    },
    commandDisposed: false,
    providerDisposed: false,
    registerCommandCalls: 0,
    registerCodeLensProviderCalls: 0,
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        monaco.registerCommandCalls += 1;
        monaco.commands.set(id, handler);
        return {
          dispose() {
            monaco.commandDisposed = true;
            monaco.commands.delete(id);
          },
        };
      },
      getModel(uri: { toString(): string }) {
        return monaco.models.get(uri.toString()) ?? null;
      },
    },
    languages: {
      registerCodeLensProvider(_languageSelector: unknown, provider: unknown) {
        monaco.registerCodeLensProviderCalls += 1;
        monaco.codeLensProvider = provider as typeof monaco.codeLensProvider;
        return {
          dispose() {
            monaco.providerDisposed = true;
          },
        };
      },
    },
  };

  return monaco as never;
}

function createFakeModel(initialText: string) {
  let text = initialText;

  const getLines = () => text.split("\n");
  const model = {
    uri: { toString: () => "file:///merge.ts" },
    get text() {
      return text;
    },
    getLinesContent() {
      return getLines();
    },
    getLineCount() {
      return getLines().length;
    },
    getLineMaxColumn(lineNumber: number) {
      return getLines()[lineNumber - 1].length + 1;
    },
    getEOL() {
      return "\n";
    },
    pushEditOperations(_beforeCursorState: unknown, operations: Array<{ range: FakeRange; text: string }>) {
      const [operation] = operations;
      text = applyEdit(text, operation.range, operation.text);
      return null;
    },
  };

  return model;
}

interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

function applyEdit(text: string, range: FakeRange, replacementText: string): string {
  const startOffset = getOffsetAt(text, range.startLineNumber, range.startColumn);
  const endOffset = getOffsetAt(text, range.endLineNumber, range.endColumn);
  return `${text.slice(0, startOffset)}${replacementText}${text.slice(endOffset)}`;
}

function getOffsetAt(text: string, lineNumber: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lineNumber - 1; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset + column - 1;
}
