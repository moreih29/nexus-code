export const MAX_READABLE_FILE_SIZE = 50 * 1024 * 1024;
/**
 * The most bytes one fs.readRange call returns; the agent's
 * MaxReadRangeLength. A larger range is read in pieces of this size.
 */
export const READ_RANGE_MAX_BYTES = 1024 * 1024;
export const BINARY_DETECTION_BYTES = 512;

/** Maximum file size for text search. Matches maxSearchFileSize in internal/search/service.go. */
export const MAX_SEARCHABLE_FILE_SIZE = 16 * 1024 * 1024;
