export const MAX_READABLE_FILE_SIZE = 50 * 1024 * 1024;
export const BINARY_DETECTION_BYTES = 512;

/** Maximum file size considered for text search — mirrors the read limit so search never reads more than the editor would. */
export const MAX_SEARCHABLE_FILE_SIZE = MAX_READABLE_FILE_SIZE;
