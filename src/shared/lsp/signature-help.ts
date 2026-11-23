import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { MarkupContentOrStringSchema } from "./primitives";
import { TextDocumentPositionArgsSchema } from "./text-document";

export const SignatureHelpTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
} as const;

export const ParameterInformationSchema = z.object({
  label: z.union([z.string(), z.tuple([NonnegativeIntegerSchema, NonnegativeIntegerSchema])]),
  documentation: MarkupContentOrStringSchema.optional(),
});
export type ParameterInformation = z.infer<typeof ParameterInformationSchema>;

export const SignatureInformationSchema = z.object({
  label: z.string(),
  documentation: MarkupContentOrStringSchema.optional(),
  parameters: z.array(ParameterInformationSchema).optional(),
  activeParameter: IntegerSchema.nullable().optional(),
});
export type SignatureInformation = z.infer<typeof SignatureInformationSchema>;

export const SignatureHelpSchema = z.object({
  signatures: z.array(SignatureInformationSchema).min(1),
  activeSignature: IntegerSchema.optional(),
  activeParameter: IntegerSchema.nullable().optional(),
});
export type SignatureHelp = z.infer<typeof SignatureHelpSchema>;

export const SignatureHelpArgsSchema = TextDocumentPositionArgsSchema.extend({
  triggerKind: IntegerSchema,
  triggerCharacter: z.string().optional(),
  isRetrigger: z.boolean(),
  activeSignatureHelp: SignatureHelpSchema.optional(),
});
export type SignatureHelpArgs = z.infer<typeof SignatureHelpArgsSchema>;
