// The analysis budget is bounded twice. The byte total protects memory: the
// analysis worker heap limit in the API is sized for it. The file count keeps
// per-file traversal and request overhead bounded independently of size.
export const MAX_SOURCE_FILES = 2_000;
export const MAX_SOURCE_FILE_BYTES = 256_000;
export const MAX_SOURCE_TOTAL_BYTES = 10_000_000;
export const MAX_INDEX_FILES = 20_000;
export const MAX_INSPECT_FILE_BYTES = 1_000_000;
