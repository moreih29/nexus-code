import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import {
  acceptBoth,
  acceptCurrent,
  acceptIncoming,
  type ConflictBlock,
  hasConflictMarkers,
  parseConflictBlocks,
} from "./conflict-parser";

const DECORATION_CURRENT = "nexus-conflict-current";
const DECORATION_INCOMING = "nexus-conflict-incoming";
const DECORATION_MARKER = "nexus-conflict-marker";

export interface AcceptCommandIds {
  current: string;
  incoming: string;
  both: string;
}

export function registerAcceptCommands(
  editor: Monaco.editor.IStandaloneCodeEditor,
): AcceptCommandIds | null {
  const current = editor.addCommand(0, (...args: unknown[]) =>
    runAcceptCommand(editor, args, acceptCurrent),
  );
  const incoming = editor.addCommand(0, (...args: unknown[]) =>
    runAcceptCommand(editor, args, acceptIncoming),
  );
  const both = editor.addCommand(0, (...args: unknown[]) =>
    runAcceptCommand(editor, args, acceptBoth),
  );

  if (current === null || incoming === null || both === null) return null;
  return { current, incoming, both };
}

export interface ConflictCodelensInstallDeps {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  commandIds: AcceptCommandIds;
}

export interface ConflictCodelensInstallation extends Monaco.IDisposable {
  refresh(): void;
}

export function installConflictCodelens(
  deps: ConflictCodelensInstallDeps,
): ConflictCodelensInstallation {
  const { editor, monaco, commandIds } = deps;

  injectConflictStyles(monaco);

  const decorationCollection = editor.createDecorationsCollection([]);

  const codelensProvider = monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      if (model !== editor.getModel()) return { lenses: [], dispose: () => {} };

      const text = model.getValue();
      if (!hasConflictMarkers(text)) return { lenses: [], dispose: () => {} };

      const blocks = parseConflictBlocks(text);
      const lenses: Monaco.languages.CodeLens[] = blocks.flatMap((block) =>
        buildLensesForBlock(block, model, commandIds),
      );

      return { lenses, dispose: () => {} };
    },

    resolveCodeLens(_model, codeLens) {
      return codeLens;
    },
  });

  function refresh(): void {
    const model = editor.getModel();
    if (!model) {
      decorationCollection.clear();
      return;
    }

    const text = model.getValue();
    if (!hasConflictMarkers(text)) {
      decorationCollection.clear();
      return;
    }

    const blocks = parseConflictBlocks(text);
    const newDecorations = blocks.flatMap((block) => buildDecorationsForBlock(block, monaco));
    decorationCollection.set(newDecorations);
  }

  refresh();

  return {
    refresh,
    dispose() {
      codelensProvider.dispose();
      decorationCollection.clear();
    },
  };
}

function runAcceptCommand(
  editor: Monaco.editor.IStandaloneCodeEditor,
  args: unknown[],
  acceptFn: (text: string, block: ConflictBlock) => string,
): void {
  const model = editor.getModel();
  if (!model) return;

  const blockIndex = args.find((arg): arg is number => typeof arg === "number");
  if (blockIndex === undefined) return;

  const text = model.getValue();
  const blocks = parseConflictBlocks(text);
  const block = blocks[blockIndex];
  if (!block) return;

  const newText = acceptFn(text, block);
  const fullRange = model.getFullModelRange();

  model.pushEditOperations(
    editor.getSelections() ?? [],
    [{ range: fullRange, text: newText }],
    () => null,
  );
}

function buildLensesForBlock(
  block: ConflictBlock,
  model: Monaco.editor.ITextModel,
  commandIds: AcceptCommandIds,
): Monaco.languages.CodeLens[] {
  const line = block.currentMarkerLine;
  const range: Monaco.IRange = {
    startLineNumber: line,
    startColumn: model.getLineFirstNonWhitespaceColumn(line),
    endLineNumber: line,
    endColumn: model.getLineMaxColumn(line),
  };

  return [
    {
      range,
      command: {
        id: commandIds.current,
        title: i18next.t("files:git.conflict.acceptCurrent"),
        arguments: [block.index],
        tooltip: i18next.t("files:git.conflict.acceptCurrentTooltip"),
      },
    },
    {
      range,
      command: {
        id: commandIds.incoming,
        title: i18next.t("files:git.conflict.acceptIncoming"),
        arguments: [block.index],
        tooltip: i18next.t("files:git.conflict.acceptIncomingTooltip"),
      },
    },
    {
      range,
      command: {
        id: commandIds.both,
        title: i18next.t("files:git.conflict.acceptBoth"),
        arguments: [block.index],
        tooltip: i18next.t("files:git.conflict.acceptBothTooltip"),
      },
    },
  ];
}

function buildDecorationsForBlock(
  block: ConflictBlock,
  monaco: typeof Monaco,
): Monaco.editor.IModelDeltaDecoration[] {
  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];

  const markerOptions: Monaco.editor.IModelDecorationOptions = {
    isWholeLine: true,
    className: DECORATION_MARKER,
    overviewRuler: { color: "#5e81ac40", position: monaco.editor.OverviewRulerLane.Left },
  };

  decorations.push({
    range: lineRange(block.currentMarkerLine),
    options: markerOptions,
  });

  if (block.current.startLine <= block.current.endLine) {
    decorations.push({
      range: sectionRange(block.current),
      options: {
        isWholeLine: true,
        className: DECORATION_CURRENT,
        overviewRuler: { color: "#5e81ac20", position: monaco.editor.OverviewRulerLane.Left },
      },
    });
  }

  if (block.baseMarkerLine !== null) {
    decorations.push({ range: lineRange(block.baseMarkerLine), options: markerOptions });
  }

  decorations.push({ range: lineRange(block.separatorLine), options: markerOptions });

  if (block.incoming.startLine <= block.incoming.endLine) {
    decorations.push({
      range: sectionRange(block.incoming),
      options: {
        isWholeLine: true,
        className: DECORATION_INCOMING,
        overviewRuler: { color: "#a3be8c20", position: monaco.editor.OverviewRulerLane.Left },
      },
    });
  }

  decorations.push({ range: lineRange(block.incomingMarkerLine), options: markerOptions });

  return decorations;
}

function injectConflictStyles(_monaco: typeof Monaco): void {
  const styleId = "nexus-conflict-decorations";
  if (typeof document !== "undefined" && !document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      `.${DECORATION_CURRENT} { background-color: rgba(94, 129, 172, 0.12) !important; }`,
      `.${DECORATION_INCOMING} { background-color: rgba(163, 190, 140, 0.12) !important; }`,
      `.${DECORATION_MARKER} { background-color: rgba(250, 249, 246, 0.05) !important; }`,
    ].join("\n");
    document.head.appendChild(style);
  }
}

function lineRange(line: number): Monaco.IRange {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
}

function sectionRange(section: { startLine: number; endLine: number }): Monaco.IRange {
  return {
    startLineNumber: section.startLine,
    startColumn: 1,
    endLineNumber: section.endLine,
    endColumn: 1,
  };
}
