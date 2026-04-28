import type {
  Hover as ProtocolHover,
  HoverParams,
  MarkedString as ProtocolMarkedString,
  MarkupContent as ProtocolMarkupContent,
  Range as ProtocolRange,
} from "vscode-languageserver-protocol";

import type {
  LspHoverContent,
  LspHoverRequest,
  LspHoverResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  isProtocolRange,
  isRecord,
  mapProtocolRange,
} from "./read-mapping";

export interface HoverAdapterContext {
  request: LspHoverRequest;
  path: string;
  uri: string;
  sendRequest(params: HoverParams): Promise<unknown>;
}

export interface LspHoverCapabilityOptions {
  now: () => Date;
}

export class LspHoverCapability {
  public constructor(private readonly options: LspHoverCapabilityOptions) {}

  public async hover(context: HoverAdapterContext): Promise<LspHoverResult> {
    const response = await context.sendRequest(buildHoverParams(context.request, context.uri));
    const mapped = mapHoverResponse(response);

    return {
      type: "lsp-hover/read/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      contents: mapped.contents,
      range: mapped.range,
      readAt: this.timestamp(),
    };
  }

  public emptyResult(request: LspHoverRequest, path: string): LspHoverResult {
    return {
      type: "lsp-hover/read/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      contents: [],
      range: null,
      readAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildHoverParams(request: LspHoverRequest, uri: string): HoverParams {
  return {
    textDocument: {
      uri,
    },
    position: request.position,
  };
}

export function mapHoverResponse(response: unknown): {
  contents: LspHoverContent[];
  range: LspHoverResult["range"];
} {
  if (!isProtocolHover(response)) {
    return {
      contents: [],
      range: null,
    };
  }

  return {
    contents: mapHoverContents(response.contents),
    range: isProtocolRange(response.range) ? mapProtocolRange(response.range) : null,
  };
}

export function mapHoverContents(contents: ProtocolHover["contents"]): LspHoverContent[] {
  if (isMarkupContent(contents)) {
    return [mapMarkupContent(contents)];
  }

  if (Array.isArray(contents)) {
    return contents.flatMap((content) => mapMarkedString(content));
  }

  return mapMarkedString(contents);
}

function mapMarkupContent(content: ProtocolMarkupContent): LspHoverContent {
  return {
    kind: content.kind === "markdown" ? "markdown" : "plaintext",
    value: content.value,
  };
}

function mapMarkedString(content: ProtocolMarkedString): LspHoverContent[] {
  if (typeof content === "string") {
    return content.length > 0
      ? [
          {
            kind: "markdown",
            value: content,
          },
        ]
      : [];
  }

  if (
    isRecord(content) &&
    typeof content.language === "string" &&
    typeof content.value === "string"
  ) {
    return [
      {
        kind: "markdown",
        value: codeFence(content.language, content.value),
      },
    ];
  }

  return [];
}

function isProtocolHover(value: unknown): value is ProtocolHover {
  return isRecord(value) && "contents" in value;
}

function isMarkupContent(value: unknown): value is ProtocolMarkupContent {
  return (
    isRecord(value) &&
    (value.kind === "markdown" || value.kind === "plaintext") &&
    typeof value.value === "string"
  );
}

function codeFence(language: string, value: string): string {
  const escapedLanguage = language.replace(/[`\r\n]/g, "");
  return `\`\`\`${escapedLanguage}\n${value}\n\`\`\``;
}
