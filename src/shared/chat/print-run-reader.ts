export const PRINT_RUN_READER_PREFIX = "print-run-reader-";

export const PRINT_RUN_READER_TAB_ID =
  /^print-run-reader-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPrintRunReader(tabId: string): boolean {
  return tabId.startsWith(PRINT_RUN_READER_PREFIX);
}
