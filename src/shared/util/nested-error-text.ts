export function nestedErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
}
