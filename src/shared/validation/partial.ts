import { z } from "zod";

type ShapeWithoutDefaults<Shape extends z.core.$ZodShape> = {
  [Key in keyof Shape]: Shape[Key] extends z.ZodDefault<infer Field> | z.ZodPrefault<infer Field>
    ? Field
    : Shape[Key];
};

export function partialWithoutDefaults<Shape extends z.core.$ZodShape>(schema: z.ZodObject<Shape>) {
  const fields = Object.entries(schema.shape).map(([key, field]) => [
    key,
    field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field,
  ]);
  return z.object(Object.fromEntries(fields) as ShapeWithoutDefaults<Shape>).partial();
}
