/**
 * Monaco CodeLens and decoration provider for in-app merge conflict resolution.
 *
 * Responsibilities:
 *   - Register a CodeLens provider that surfaces per-block resolution actions
 *     ("Accept Current Change", "Accept Incoming Change", "Accept Both Changes",
 *     "Compare Changes") above each conflict block's opening marker line.
 *   - Register Monaco commands that apply the chosen resolution by rewriting
 *     the block in the model via `pushEditOperations`.
 *   - Apply editor decorations that tint the current (ours) and incoming
 *     (theirs) regions with subtle background colors so users can orient
 *     themselves before picking an action.
 *
 * Activation guard: all providers and decorations are only applied when the
 * active model actually contains conflict markers. Normal files are unaffected.
 *
 * Disposal: the returned disposer from `installConflictCodelens` must be
 * called on editor unmount or when the model changes away from a conflict file.
 * This tears down the CodeLens provider registration, command registrations,
 * and active decorations so they do not leak into subsequent models.
 *
 * Color rationale: hex literals are required by Monaco's theme engine (rgba()
 * is silently rejected). Values derive from the warm-parchment/earth-tone
 * palette used elsewhere in the editor (see editor-palette.ts).
 *   - Current (ours) background: blue-tinted warm-parchment at α 0.08
 *   - Incoming (theirs) background: green-tinted warm-parchment at α 0.08
 *   - Marker lines: slightly stronger tint at α 0.12
 */

import type * as Monaco from "monaco-editor";
import {
  acceptBoth,
  acceptCurrent,
  acceptIncoming,
  hasConflictMarkers,
  parseConflictBlocks,
  type ConflictBlock,
} from "./conflict-parser";

// ---------------------------------------------------------------------------
// Decoration class names (CSS identifiers injected into Monaco's style sheet).
// ---------------------------------------------------------------------------
const DECORATION_CURRENT = "nexus-conflict-current";
const DECORATION_INCOMING = "nexus-conflict-incoming";
const DECORATION_MARKER = "nexus-conflict-marker";

// ---------------------------------------------------------------------------
// Accept-command registration
// ---------------------------------------------------------------------------

/**
 * Command-service IDs for the three accept actions, as returned by
 * `editor.addCommand`. These are generated per editor instance — they are not
 * stable string constants — so they must be threaded into the CodeLens items.
 */
export interface AcceptCommandIds {
  current: string;
  incoming: string;
  both: string;
}

/**
 * Registers the three accept commands on `editor` and returns their generated,
 * command-service-resolvable IDs.
 *
 * Must be called once per editor instance (not per model): `editor.addCommand`
 * provides no disposer, so re-registering on every model switch would leak
 * commands. The CodeLens `command.id` fields must reference exactly these
 * returned IDs — hand-written string constants do not work, because
 * `addCommand`'s third parameter is a `when` context expression, not the ID.
 *
 * Returns null when Monaco fails to register a command (it yields null on
 * failure); callers should then skip installing the conflict UI.
 */
export function registerAcceptCommands(
  editor: Monaco.editor.IStandaloneCodeEditor,
): AcceptCommandIds | null {
  // The command service invokes handlers as (accessor, ...args); runAcceptCommand
  // scans the argument list for the numeric block index, tolerating that prefix.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dependencies injected by callers. Using a typed interface keeps the module
 * testable without mock.module pollution (pattern-bun-mock-conventions rule 1).
 */
export interface ConflictCodelensInstallDeps {
  /** The live standalone editor instance. */
  editor: Monaco.editor.IStandaloneCodeEditor;
  /** The monaco namespace (singleton for the renderer process). */
  monaco: typeof Monaco;
  /** Accept-command IDs registered once per editor via `registerAcceptCommands`. */
  commandIds: AcceptCommandIds;
}

export interface ConflictCodelensInstallation extends Monaco.IDisposable {
  /** Call after the model content changes to refresh CodeLens + decorations. */
  refresh(): void;
}

/**
 * Installs the conflict resolution CodeLens + decoration providers on the given
 * editor. Returns an installation handle whose `dispose()` tears everything
 * down and whose `refresh()` re-runs the parse + decoration cycle when content
 * changes (the CodeLens provider drives its own re-query via `onDidChange`).
 *
 * Safe to call multiple times for the same editor — each call returns an
 * independent handle; callers are responsible for disposing the old one first.
 */
export function installConflictCodelens(
  deps: ConflictCodelensInstallDeps,
): ConflictCodelensInstallation {
  const { editor, monaco, commandIds } = deps;

  // Style injection is idempotent — Monaco merges duplicate class rules.
  injectConflictStyles(monaco);

  // Track decoration collection so we can update / remove it cleanly.
  const decorationCollection = editor.createDecorationsCollection([]);

  // ---------------------------------------------------------------------------
  // CodeLens provider — registered language-agnostic (wildcard) because
  // conflict markers can appear in any file type. The accept commands are
  // registered once per editor by the caller; we only reference their IDs.
  // ---------------------------------------------------------------------------
  const codelensProvider = monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      // Only activate for the model currently mounted in this editor.
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
      // Lenses are fully populated in provideCodeLenses — nothing to resolve.
      return codeLens;
    },
  });

  // ---------------------------------------------------------------------------
  // Decoration refresh helper — called on mount and after each accept action.
  // Decorations are driven separately from CodeLens because Monaco's CodeLens
  // provider re-queries automatically when the model changes; decorations need
  // an explicit `set()` call via this helper.
  // ---------------------------------------------------------------------------
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

  // Run an initial pass so decorations appear immediately when the provider is installed.
  refresh();

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------
  return {
    refresh,
    dispose() {
      codelensProvider.dispose();
      decorationCollection.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

/**
 * Executes an accept action for the conflict block identified by `blockIndex`
 * (passed as the first argument from the CodeLens command).
 *
 * Parses the current model text, applies the accept function, then writes the
 * result back via `pushEditOperations` so the change is undoable.
 */
function runAcceptCommand(
  editor: Monaco.editor.IStandaloneCodeEditor,
  args: unknown[],
  acceptFn: (text: string, block: ConflictBlock) => string,
): void {
  const model = editor.getModel();
  if (!model) return;

  // The command service prefixes an `accessor` argument before the CodeLens
  // command arguments, so scan for the numeric block index rather than
  // assuming a fixed position.
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

// ---------------------------------------------------------------------------
// CodeLens construction helpers
// ---------------------------------------------------------------------------

/**
 * Builds the three CodeLens items for one conflict block. All lenses sit on
 * the `<<<<<<<` marker line (the block's first line) so they appear as a
 * group above the conflict content.
 *
 * "Compare Changes" is intentionally omitted — per-block inline compare
 * requires a separate widget-mounting surface and is tracked as a follow-up
 * task. A stub lens that fires a missing command logs a Monaco warning on
 * click, which is worse than no button at all.
 */
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
        title: "Accept Current Change",
        arguments: [block.index],
        tooltip: "Keep the current (ours / HEAD) side and remove all markers",
      },
    },
    {
      range,
      command: {
        id: commandIds.incoming,
        title: "Accept Incoming Change",
        arguments: [block.index],
        tooltip: "Keep the incoming (theirs) side and remove all markers",
      },
    },
    {
      range,
      command: {
        id: commandIds.both,
        title: "Accept Both Changes",
        arguments: [block.index],
        tooltip: "Concatenate current then incoming; remove all markers",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Decoration construction helpers
// ---------------------------------------------------------------------------

/**
 * Produces the editor decorations for one conflict block:
 *   - marker lines tinted with the "marker" color class
 *   - current-side content region tinted with the "current" class
 *   - incoming-side content region tinted with the "incoming" class
 *
 * The base section (diff3) is intentionally not decorated — it is already
 * delimited by the `|||||||` marker decoration.
 */
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

  // Current marker (`<<<<<<<`)
  decorations.push({
    range: lineRange(block.currentMarkerLine),
    options: markerOptions,
  });

  // Current content region
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

  // Base marker (`|||||||`) — tinted same as other markers
  if (block.baseMarkerLine !== null) {
    decorations.push({ range: lineRange(block.baseMarkerLine), options: markerOptions });
  }

  // Separator (`=======`)
  decorations.push({ range: lineRange(block.separatorLine), options: markerOptions });

  // Incoming content region
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

  // Incoming marker (`>>>>>>>`)
  decorations.push({ range: lineRange(block.incomingMarkerLine), options: markerOptions });

  return decorations;
}

// ---------------------------------------------------------------------------
// CSS injection helpers
// ---------------------------------------------------------------------------

/**
 * Injects the CSS classes referenced by our decoration options into the Monaco
 * stylesheet. This is idempotent — if the style tag already exists it is not
 * duplicated.
 *
 * Color values follow the Monaco hex-only constraint documented in
 * `editor-palette.ts`. Values are warm-parchment and Nordic Blue/Green tints
 * at low opacity so they are legible on the dark background (#1a1917) without
 * overwhelming the code.
 *
 *   Current (ours):   Nordic Blue  (#5e81ac) α 0.12 → background tint
 *   Incoming (theirs): Nordic Green (#a3be8c) α 0.12 → background tint
 *   Markers:           neutral warm-parchment (#faf9f6) α 0.05
 */
function injectConflictStyles(_monaco: typeof Monaco): void {
  const styleId = "nexus-conflict-decorations";
  if (
    typeof document !== "undefined" &&
    !document.getElementById(styleId)
  ) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = [
      // Use rgba() here — this is a <style> tag for the DOM, not Monaco's
      // theme color map, so standard CSS syntax applies.
      `.${DECORATION_CURRENT} { background-color: rgba(94, 129, 172, 0.12) !important; }`,
      `.${DECORATION_INCOMING} { background-color: rgba(163, 190, 140, 0.12) !important; }`,
      `.${DECORATION_MARKER} { background-color: rgba(250, 249, 246, 0.05) !important; }`,
    ].join("\n");
    document.head.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

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
