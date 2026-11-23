export interface ClaudeTurnResult {
  readonly outcome: "completed" | "interrupted" | "error";
  readonly subtype: string;
  readonly terminalReason?: string;
  readonly promptId?: string;
  readonly isError: boolean;
  readonly detail?: string;
}

export function claudeTurnResult(message: Record<string, unknown>): ClaudeTurnResult {
  const subtype = typeof message.subtype === "string" ? message.subtype : "success";
  const terminalReason =
    typeof message.terminal_reason === "string" ? message.terminal_reason : undefined;
  const isError = message.is_error === true || subtype !== "success";
  const interrupted = terminalReason === "interrupted" || terminalReason?.startsWith("aborted");
  const outcome = interrupted ? "interrupted" : isError ? "error" : "completed";
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((error) => typeof error === "string")
    : [];
  const detail =
    typeof message.result === "string"
      ? message.result
      : outcome === "error"
        ? errors.join("\n") || (subtype === "success" ? "Claude stopped on an error" : subtype)
        : undefined;
  return {
    outcome,
    subtype,
    terminalReason,
    promptId: typeof message.prompt_id === "string" ? message.prompt_id : undefined,
    isError,
    detail,
  };
}
