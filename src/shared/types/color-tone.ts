import { z } from "zod";

export const ColorToneSchema = z.enum(["subdued", "default", "prominent", "pinned"]);

export type ColorTone = z.infer<typeof ColorToneSchema>;
