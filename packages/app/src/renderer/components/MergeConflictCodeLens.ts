type MonacoApi = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoCodeLens = import("monaco-editor").languages.CodeLens;
type MonacoCodeLensList = import("monaco-editor").languages.CodeLensList;

export type MergeConflictResolution = "current" | "incoming" | "both";

export interface MergeConflictBlock {
  startLineNumber: number;
  separatorLineNumber: number;
  endLineNumber: number;
}

interface MergeConflictRegistration {
  disposable: MonacoDisposable;
  references: number;
}

const MERGE_CONFLICT_COMMAND_ID = "nexus.mergeConflict.resolve";
const START_MARKER_REGEX = /^<<<<<<< .+$/;
const SEPARATOR_MARKER_REGEX = /^=======$/;
const END_MARKER_REGEX = /^>>>>>>> .+$/;
const registrations = new WeakMap<MonacoApi, MergeConflictRegistration>();

const RESOLUTION_ACTIONS: Array<{ resolution: MergeConflictResolution; title: string }> = [
  { resolution: "current", title: "Accept Current" },
  { resolution: "incoming", title: "Accept Incoming" },
  { resolution: "both", title: "Accept Both" },
];

export function registerMergeConflictCodeLensProvider(monaco: MonacoApi): MonacoDisposable {
  const existing = registrations.get(monaco);
  if (existing) {
    existing.references += 1;
    return createRegistrationReference(monaco);
  }

  const commandDisposable = monaco.editor.registerCommand(
    MERGE_CONFLICT_COMMAND_ID,
    (_accessor, modelUri: string, conflict: MergeConflictBlock, resolution: MergeConflictResolution) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(modelUri));
      if (!model) {
        return;
      }

      applyMergeConflictResolutionToModel(monaco, model, conflict, resolution);
    },
  );
  const providerDisposable = monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      const conflicts = findMergeConflictsInLines(model.getLinesContent());
      return {
        lenses: conflicts.flatMap((conflict) => createCodeLenses(monaco, model, conflict)),
        dispose() {},
      } satisfies MonacoCodeLensList;
    },
  });

  registrations.set(monaco, {
    disposable: {
      dispose() {
        providerDisposable.dispose();
        commandDisposable.dispose();
      },
    },
    references: 1,
  });

  return createRegistrationReference(monaco);
}

export function findMergeConflicts(text: string): MergeConflictBlock[] {
  return findMergeConflictsInLines(text.split(/\r\n|\r|\n/));
}

export function findMergeConflictsInLines(lines: readonly string[]): MergeConflictBlock[] {
  const conflicts: MergeConflictBlock[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    if (!START_MARKER_REGEX.test(lines[lineIndex])) {
      lineIndex += 1;
      continue;
    }

    const separatorIndex = findNextMarkerIndex(lines, lineIndex + 1, SEPARATOR_MARKER_REGEX);
    if (separatorIndex === -1) {
      lineIndex += 1;
      continue;
    }

    const endIndex = findNextMarkerIndex(lines, separatorIndex + 1, END_MARKER_REGEX);
    if (endIndex === -1) {
      lineIndex += 1;
      continue;
    }

    conflicts.push({
      startLineNumber: lineIndex + 1,
      separatorLineNumber: separatorIndex + 1,
      endLineNumber: endIndex + 1,
    });
    lineIndex = endIndex + 1;
  }

  return conflicts;
}

export function resolveMergeConflictLines(
  lines: readonly string[],
  conflict: MergeConflictBlock,
  resolution: MergeConflictResolution,
): string[] {
  if (!isCurrentConflict(lines, conflict)) {
    return [...lines];
  }

  const beforeConflict = lines.slice(0, conflict.startLineNumber - 1);
  const afterConflict = lines.slice(conflict.endLineNumber);
  return [
    ...beforeConflict,
    ...getResolutionLines(lines, conflict, resolution),
    ...afterConflict,
  ];
}

export function applyMergeConflictResolutionToModel(
  monaco: MonacoApi,
  model: MonacoModel,
  conflict: MergeConflictBlock,
  resolution: MergeConflictResolution,
): boolean {
  const lines = model.getLinesContent();
  if (!isCurrentConflict(lines, conflict)) {
    return false;
  }

  const replacementLines = getResolutionLines(lines, conflict, resolution);
  const isConflictAtEnd = conflict.endLineNumber >= model.getLineCount();
  const range = isConflictAtEnd
    ? new monaco.Range(
        conflict.startLineNumber,
        1,
        conflict.endLineNumber,
        model.getLineMaxColumn(conflict.endLineNumber),
      )
    : new monaco.Range(conflict.startLineNumber, 1, conflict.endLineNumber + 1, 1);
  const replacementText = replacementLines.join(model.getEOL());

  model.pushEditOperations(
    null,
    [
      {
        range,
        text: isConflictAtEnd || replacementLines.length === 0
          ? replacementText
          : `${replacementText}${model.getEOL()}`,
      },
    ],
    () => null,
  );
  return true;
}

function createCodeLenses(
  monaco: MonacoApi,
  model: MonacoModel,
  conflict: MergeConflictBlock,
): MonacoCodeLens[] {
  return RESOLUTION_ACTIONS.map(({ resolution, title }) => ({
    range: new monaco.Range(conflict.startLineNumber, 1, conflict.startLineNumber, 1),
    command: {
      id: MERGE_CONFLICT_COMMAND_ID,
      title,
      arguments: [model.uri.toString(), conflict, resolution],
    },
  }));
}

function getResolutionLines(
  lines: readonly string[],
  conflict: MergeConflictBlock,
  resolution: MergeConflictResolution,
): string[] {
  const currentLines = lines.slice(conflict.startLineNumber, conflict.separatorLineNumber - 1);
  const incomingLines = lines.slice(conflict.separatorLineNumber, conflict.endLineNumber - 1);

  switch (resolution) {
    case "current":
      return currentLines;
    case "incoming":
      return incomingLines;
    case "both":
      return [...currentLines, ...incomingLines];
  }
}

function isCurrentConflict(lines: readonly string[], conflict: MergeConflictBlock): boolean {
  return (
    conflict.startLineNumber >= 1 &&
    conflict.startLineNumber < conflict.separatorLineNumber &&
    conflict.separatorLineNumber < conflict.endLineNumber &&
    conflict.endLineNumber <= lines.length &&
    START_MARKER_REGEX.test(lines[conflict.startLineNumber - 1]) &&
    SEPARATOR_MARKER_REGEX.test(lines[conflict.separatorLineNumber - 1]) &&
    END_MARKER_REGEX.test(lines[conflict.endLineNumber - 1])
  );
}

function findNextMarkerIndex(lines: readonly string[], startIndex: number, markerRegex: RegExp): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (markerRegex.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function createRegistrationReference(monaco: MonacoApi): MonacoDisposable {
  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      const registration = registrations.get(monaco);
      if (!registration) {
        return;
      }

      registration.references -= 1;
      if (registration.references > 0) {
        return;
      }

      registration.disposable.dispose();
      registrations.delete(monaco);
    },
  };
}
