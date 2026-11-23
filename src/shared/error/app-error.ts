import { z } from "zod";
import { GitActionHintSchema } from "../git/types";

export const APP_ERROR_CATEGORIES = ["invalid-input", "cancelled", "failed", "bug"] as const;

export const AppErrorCategorySchema = z.enum(APP_ERROR_CATEGORIES);
export type AppErrorCategory = z.infer<typeof AppErrorCategorySchema>;

export const APP_ERROR_DOMAINS = ["git", "fs", "ssh"] as const;

export const AppErrorDomainSchema = z.enum(APP_ERROR_DOMAINS);
export type AppErrorDomain = z.infer<typeof AppErrorDomainSchema>;

export const ActionHintSchema = GitActionHintSchema;
export type ActionHint = z.infer<typeof ActionHintSchema>;

export const AppErrorSchema = z.object({
  category: AppErrorCategorySchema,

  domain: AppErrorDomainSchema.optional(),

  code: z.string().optional(),

  message: z.string(),

  hint: ActionHintSchema.optional(),

  correlationId: z.string().optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

export function appErrorInvalidInput(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "invalid-input", message, ...options };
}

export function appErrorCancelled(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "cancelled", message, ...options };
}

export function appErrorFailed(
  message: string,
  options: Pick<AppError, "domain" | "code" | "hint" | "correlationId"> = {},
): AppError {
  return { category: "failed", message, ...options };
}

export function appErrorBug(
  message: string,
  options: Pick<AppError, "domain" | "code" | "correlationId"> = {},
): AppError {
  return { category: "bug", message, ...options };
}
