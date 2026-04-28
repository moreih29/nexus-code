import type {
  CompletionItem as ProtocolCompletionItem,
  CompletionList as ProtocolCompletionList,
  CompletionParams,
  CompletionTriggerKind as ProtocolCompletionTriggerKind,
  InsertReplaceEdit as ProtocolInsertReplaceEdit,
  InsertTextFormat as ProtocolInsertTextFormat,
  Range as ProtocolRange,
  TextEdit as ProtocolTextEdit,
} from "vscode-languageserver-protocol";

import type {
  LspCompletionEditRange,
  LspCompletionInsertTextFormat,
  LspCompletionItem,
  LspCompletionItemKind,
  LspCompletionRequest,
  LspCompletionResult,
  LspCompletionTextEdit,
  LspCompletionTriggerKind,
} from "../../../../../shared/src/contracts/editor/editor-bridge";

type ProtocolCompletionItemDefaults = NonNullable<ProtocolCompletionList["itemDefaults"]>;
type ProtocolCompletionEditRange = NonNullable<ProtocolCompletionItemDefaults["editRange"]>;

export interface CompletionAdapterContext {
  request: LspCompletionRequest;
  path: string;
  uri: string;
  sendRequest(params: CompletionParams): Promise<unknown>;
}

export interface LspCompletionCapabilityOptions {
  now: () => Date;
}

export class LspCompletionCapability {
  public constructor(private readonly options: LspCompletionCapabilityOptions) {}

  public async complete(context: CompletionAdapterContext): Promise<LspCompletionResult> {
    const response = await context.sendRequest(buildCompletionParams(context.request, context.uri));

    return {
      type: "lsp-completion/complete/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      isIncomplete: completionResponseIsIncomplete(response),
      items: mapCompletionResponse(response),
      completedAt: this.timestamp(),
    };
  }

  public emptyResult(request: LspCompletionRequest, path: string): LspCompletionResult {
    return {
      type: "lsp-completion/complete/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      isIncomplete: false,
      items: [],
      completedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildCompletionParams(
  request: LspCompletionRequest,
  uri: string,
): CompletionParams {
  const triggerKind = mapCompletionTriggerKind(request.triggerKind);
  return {
    textDocument: {
      uri,
    },
    position: request.position,
    context: {
      triggerKind,
      triggerCharacter:
        triggerKind === 2 && request.triggerCharacter
          ? request.triggerCharacter
          : undefined,
    },
  };
}

export function mapCompletionResponse(response: unknown): LspCompletionItem[] {
  const { items, itemDefaults } = normalizeCompletionResponse(response);
  return items.map((item) => mapCompletionItem(item, itemDefaults));
}

export function mapCompletionItem(
  item: ProtocolCompletionItem,
  itemDefaults?: ProtocolCompletionList["itemDefaults"],
): LspCompletionItem {
  const label = item.label;
  const mainTextEdit = item.textEdit ?? null;
  const defaultEditRange = itemDefaults?.editRange ?? null;
  const insertText = resolveInsertText(item, mainTextEdit, defaultEditRange);

  return {
    label,
    kind: mapCompletionItemKind(item.kind),
    detail: item.detail ?? null,
    documentation: mapDocumentation(item.documentation),
    sortText: item.sortText ?? null,
    filterText: item.filterText ?? null,
    insertText,
    insertTextFormat: mapInsertTextFormat(
      item.insertTextFormat ?? itemDefaults?.insertTextFormat,
    ),
    range: mapCompletionEditRange(mainTextEdit, defaultEditRange),
    additionalTextEdits: (item.additionalTextEdits ?? []).map(mapTextEdit),
    commitCharacters: item.commitCharacters ?? itemDefaults?.commitCharacters ?? null,
    preselect: item.preselect ?? null,
    deprecated: item.deprecated ?? item.tags?.includes(1) ?? null,
  };
}

export function mapCompletionItemKind(
  kind: ProtocolCompletionItem["kind"] | undefined,
): LspCompletionItemKind {
  switch (kind) {
    case 2:
      return "method";
    case 3:
      return "function";
    case 4:
      return "constructor";
    case 5:
      return "field";
    case 6:
      return "variable";
    case 7:
      return "class";
    case 8:
      return "interface";
    case 9:
      return "module";
    case 10:
      return "property";
    case 11:
      return "unit";
    case 12:
      return "value";
    case 13:
      return "enum";
    case 14:
      return "keyword";
    case 15:
      return "snippet";
    case 16:
      return "color";
    case 17:
      return "file";
    case 18:
      return "reference";
    case 19:
      return "folder";
    case 20:
      return "enum-member";
    case 21:
      return "constant";
    case 22:
      return "struct";
    case 23:
      return "event";
    case 24:
      return "operator";
    case 25:
      return "type-parameter";
    case 1:
    default:
      return "text";
  }
}

function completionResponseIsIncomplete(response: unknown): boolean {
  return isCompletionList(response) ? response.isIncomplete === true : false;
}

function normalizeCompletionResponse(response: unknown): {
  items: ProtocolCompletionItem[];
  itemDefaults?: ProtocolCompletionList["itemDefaults"];
} {
  if (Array.isArray(response)) {
    return {
      items: response.filter(isProtocolCompletionItem),
    };
  }

  if (isCompletionList(response)) {
    return {
      items: response.items.filter(isProtocolCompletionItem),
      itemDefaults: response.itemDefaults,
    };
  }

  return {
    items: [],
  };
}

function mapCompletionTriggerKind(
  triggerKind: LspCompletionTriggerKind | null | undefined,
): ProtocolCompletionTriggerKind {
  switch (triggerKind) {
    case "trigger-character":
      return 2;
    case "trigger-for-incomplete-completions":
      return 3;
    case "invoked":
    default:
      return 1;
  }
}

function resolveInsertText(
  item: ProtocolCompletionItem,
  mainTextEdit: ProtocolTextEdit | ProtocolInsertReplaceEdit | null,
  defaultEditRange: ProtocolCompletionEditRange | null,
): string {
  if (mainTextEdit) {
    return mainTextEdit.newText;
  }

  if (defaultEditRange && item.textEditText) {
    return item.textEditText;
  }

  return item.insertText ?? item.label;
}

function mapInsertTextFormat(
  format: ProtocolInsertTextFormat | undefined,
): LspCompletionInsertTextFormat {
  return format === 2 ? "snippet" : "plain-text";
}

function mapCompletionEditRange(
  mainTextEdit: ProtocolTextEdit | ProtocolInsertReplaceEdit | null,
  defaultEditRange: ProtocolCompletionEditRange | null,
): LspCompletionEditRange | null {
  if (mainTextEdit) {
    if (isInsertReplaceEdit(mainTextEdit)) {
      return {
        insert: mapRange(mainTextEdit.insert),
        replace: mapRange(mainTextEdit.replace),
      };
    }

    return mapRange(mainTextEdit.range);
  }

  if (!defaultEditRange) {
    return null;
  }

  if (isProtocolRange(defaultEditRange)) {
    return mapRange(defaultEditRange);
  }

  return {
    insert: mapRange(defaultEditRange.insert),
    replace: mapRange(defaultEditRange.replace),
  };
}

function mapTextEdit(edit: ProtocolTextEdit): LspCompletionTextEdit {
  return {
    range: mapRange(edit.range),
    newText: edit.newText,
  };
}

function mapRange(range: ProtocolRange): LspCompletionTextEdit["range"] {
  return {
    start: {
      line: finiteInteger(range.start.line),
      character: finiteInteger(range.start.character),
    },
    end: {
      line: finiteInteger(range.end.line),
      character: finiteInteger(range.end.character),
    },
  };
}

function mapDocumentation(documentation: ProtocolCompletionItem["documentation"]): string | null {
  if (typeof documentation === "string") {
    return documentation;
  }

  if (
    typeof documentation === "object" &&
    documentation !== null &&
    "value" in documentation &&
    typeof documentation.value === "string"
  ) {
    return documentation.value;
  }

  return null;
}

function isCompletionList(value: unknown): value is ProtocolCompletionList {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    typeof value.isIncomplete === "boolean"
  );
}

function isProtocolCompletionItem(value: unknown): value is ProtocolCompletionItem {
  return isRecord(value) && typeof value.label === "string";
}

function isInsertReplaceEdit(
  edit: ProtocolTextEdit | ProtocolInsertReplaceEdit,
): edit is ProtocolInsertReplaceEdit {
  return "insert" in edit && "replace" in edit;
}

function isProtocolRange(value: unknown): value is ProtocolRange {
  return (
    isRecord(value) &&
    isRecord(value.start) &&
    isRecord(value.end) &&
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  );
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
