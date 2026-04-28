import type {
  SignatureHelp as ProtocolSignatureHelp,
  SignatureHelpParams,
  SignatureHelpTriggerKind as ProtocolSignatureHelpTriggerKind,
} from "vscode-languageserver-protocol";

import type {
  LspSignatureHelp,
  LspSignatureHelpRequest,
  LspSignatureHelpResult,
  LspSignatureHelpTriggerKind,
  LspSignatureInformation,
  LspSignatureParameterInformation,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import {
  buildTextDocumentPositionParams,
  mapDocumentationToString,
} from "./edit-mapping";
import { finiteInteger, isRecord } from "./read-mapping";

export interface SignatureHelpAdapterContext {
  request: LspSignatureHelpRequest;
  path: string;
  uri: string;
  sendRequest(params: SignatureHelpParams): Promise<unknown>;
}

export interface LspSignatureHelpCapabilityOptions {
  now: () => Date;
}

export class LspSignatureHelpCapability {
  public constructor(private readonly options: LspSignatureHelpCapabilityOptions) {}

  public async signatureHelp(
    context: SignatureHelpAdapterContext,
  ): Promise<LspSignatureHelpResult> {
    const response = await context.sendRequest(
      buildSignatureHelpParams(context.request, context.uri),
    );

    return {
      type: "lsp-signature-help/get/result",
      workspaceId: context.request.workspaceId,
      path: context.path,
      language: context.request.language,
      signatureHelp: mapSignatureHelpResponse(response),
      resolvedAt: this.timestamp(),
    };
  }

  public emptyResult(
    request: LspSignatureHelpRequest,
    path: string,
  ): LspSignatureHelpResult {
    return {
      type: "lsp-signature-help/get/result",
      workspaceId: request.workspaceId,
      path,
      language: request.language,
      signatureHelp: null,
      resolvedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}

export function buildSignatureHelpParams(
  request: LspSignatureHelpRequest,
  uri: string,
): SignatureHelpParams {
  return {
    ...buildTextDocumentPositionParams(uri, request.position),
    context: {
      triggerKind: mapSignatureHelpTriggerKind(request.triggerKind),
      triggerCharacter: request.triggerCharacter ?? undefined,
      isRetrigger: request.isRetrigger === true,
      activeSignatureHelp: request.activeSignatureHelp
        ? mapSharedSignatureHelpToProtocol(request.activeSignatureHelp)
        : undefined,
    },
  };
}

export function mapSignatureHelpResponse(response: unknown): LspSignatureHelp | null {
  if (!isProtocolSignatureHelp(response)) {
    return null;
  }

  return {
    signatures: response.signatures.map(mapSignatureInformation),
    activeSignature: finiteInteger(response.activeSignature),
    activeParameter: finiteInteger(response.activeParameter),
  };
}

function mapSignatureInformation(
  signature: ProtocolSignatureHelp["signatures"][number],
): LspSignatureInformation {
  return {
    label: signature.label,
    documentation: mapDocumentationToString(signature.documentation),
    parameters: (signature.parameters ?? []).map(mapParameterInformation),
    activeParameter:
      typeof signature.activeParameter === "number"
        ? finiteInteger(signature.activeParameter)
        : null,
  };
}

function mapParameterInformation(
  parameter: NonNullable<ProtocolSignatureHelp["signatures"][number]["parameters"]>[number],
): LspSignatureParameterInformation {
  return {
    label: Array.isArray(parameter.label)
      ? [finiteInteger(parameter.label[0]), finiteInteger(parameter.label[1])]
      : parameter.label,
    documentation: mapDocumentationToString(parameter.documentation),
  };
}

function mapSharedSignatureHelpToProtocol(
  signatureHelp: LspSignatureHelp,
): ProtocolSignatureHelp {
  return {
    signatures: signatureHelp.signatures.map((signature) => ({
      label: signature.label,
      documentation: signature.documentation ?? undefined,
      parameters: signature.parameters.map((parameter) => ({
        label: parameter.label,
        documentation: parameter.documentation ?? undefined,
      })),
      activeParameter: signature.activeParameter ?? undefined,
    })),
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter,
  };
}

function mapSignatureHelpTriggerKind(
  triggerKind: LspSignatureHelpTriggerKind | null | undefined,
): ProtocolSignatureHelpTriggerKind {
  switch (triggerKind) {
    case "trigger-character":
      return 2;
    case "content-change":
      return 3;
    case "invoked":
    default:
      return 1;
  }
}

function isProtocolSignatureHelp(value: unknown): value is ProtocolSignatureHelp {
  return (
    isRecord(value) &&
    Array.isArray(value.signatures) &&
    value.signatures.every(isProtocolSignatureInformation)
  );
}

function isProtocolSignatureInformation(value: unknown): boolean {
  return isRecord(value) && typeof value.label === "string";
}
