export interface Errno {
  readonly code: string;
  readonly syscall: string;
}

export function errnoOf(error: unknown): Errno | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, syscall } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || typeof syscall !== "string") return undefined;
  return { code, syscall };
}

export function errnoText(error: unknown): string | undefined {
  const errno = errnoOf(error);
  return errno && `${errno.code} (${errno.syscall})`;
}
