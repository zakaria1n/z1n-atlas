import {
  MAX_INDEX_FILES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_TOTAL_BYTES,
} from "@z1n/contracts";

export const ANALYSIS_LIMITS = `up to ${MAX_SOURCE_FILES} files, ${
  MAX_SOURCE_FILE_BYTES / 1000
} KB per file and ${MAX_SOURCE_TOTAL_BYTES / 1_000_000} MB total are selected for analysis`;
export const INDEX_LIMITS = `up to ${MAX_INDEX_FILES.toLocaleString(
  "en-US",
)} eligible paths are indexed and can be opened on demand`;
