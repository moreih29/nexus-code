// Signature help: the call's signature shown while its arguments are typed,
// the one being typed highlighted.

import { z } from "zod";
import { MarkupContentOrStringSchema } from "./primitives";
import { TextDocumentPositionArgsSchema } from "./text-document";

export const SignatureHelpTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
} as const;

export const ParameterInformationSchema = z.object({
  /** The parameter's text, or its [start, end) offsets in the signature's label. */
  label: z.union([
    z.string(),
    z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  ]),
  documentation: MarkupContentOrStringSchema.optional(),
});
export type ParameterInformation = z.infer<typeof ParameterInformationSchema>;

export const SignatureInformationSchema = z.object({
  label: z.string(),
  documentation: MarkupContentOrStringSchema.optional(),
  parameters: z.array(ParameterInformationSchema).optional(),
  /** Overrides SignatureHelp.activeParameter for this signature; null for none. */
  activeParameter: z.number().int().nullable().optional(),
});
export type SignatureInformation = z.infer<typeof SignatureInformationSchema>;

export const SignatureHelpSchema = z.object({
  signatures: z.array(SignatureInformationSchema).min(1),
  activeSignature: z.number().int().optional(),
  /** Null when no parameter is being typed. */
  activeParameter: z.number().int().nullable().optional(),
});
export type SignatureHelp = z.infer<typeof SignatureHelpSchema>;

export const SignatureHelpArgsSchema = TextDocumentPositionArgsSchema.extend({
  triggerKind: z.number().int(),
  triggerCharacter: z.string().optional(),
  /** Whether the signature is already shown, and this asks again as the user types. */
  isRetrigger: z.boolean(),
  /** What is shown, so the server can keep the overload the user picked. */
  activeSignatureHelp: SignatureHelpSchema.optional(),
});
export type SignatureHelpArgs = z.infer<typeof SignatureHelpArgsSchema>;
