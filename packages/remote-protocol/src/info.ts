import { z } from "zod";
import { IntegerSchema } from "./validation.js";

export const ServerInfoSchema = z.object({
  signIn: z.array(z.string()),
  relay: z.object({ version: IntegerSchema }).nullable(),
  voice: z.object({ version: IntegerSchema }).nullable(),
  accountKeys: z.object({ version: IntegerSchema }).nullable().optional(),
  push: z
    .object({
      version: IntegerSchema,
      environments: z.array(z.string()),
    })
    .nullable()
    .optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
