export const MAX_READABLE_FILE_SIZE = 50 * 1024 * 1024;
/**
 * The most bytes one fs.readRange call returns; the agent's
 * MaxReadRangeLength. A larger range is read in pieces of this size.
 */
export const READ_RANGE_MAX_BYTES = 1024 * 1024;
export const BINARY_DETECTION_BYTES = 512;

/** Maximum file size considered for text search — mirrors the read limit so search never reads more than the editor would. */
export const MAX_SEARCHABLE_FILE_SIZE = MAX_READABLE_FILE_SIZE;
