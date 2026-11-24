import { describe, expect, it } from "vitest";
import { analysisRequestSchema } from "../http";
import {
  MAX_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_TOTAL_BYTES,
} from "./limits";
describe("source bounds", () => {
  const request = (files: { path: string; content: string }[]) => ({
    files,
    origin: "local" as const,
    consent: true,
  });
  it("accepts the file limit but rejects one file more and duplicate paths", () => {
    const files = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: "x",
    }));
    expect(
      analysisRequestSchema.safeParse(request(files.slice(0, MAX_SOURCE_FILES)))
        .success,
    ).toBe(true);
    expect(analysisRequestSchema.safeParse(request(files)).success).toBe(false);
    expect(
      analysisRequestSchema.safeParse(request([files[0], files[0]])).success,
    ).toBe(false);
  });
  it("enforces per-file and total limits by UTF-8 bytes", () => {
    const overPerFile = "\u00e9".repeat(MAX_SOURCE_FILE_BYTES / 2 + 1);
    expect(
      analysisRequestSchema.safeParse(
        request([{ path: "x.ts", content: overPerFile }]),
      ).success,
    ).toBe(false);
    // Files at exactly the per-file limit, so that only the total budget decides.
    const atPerFileLimit = "\u00e9".repeat(MAX_SOURCE_FILE_BYTES / 2);
    const fits = Math.floor(MAX_SOURCE_TOTAL_BYTES / MAX_SOURCE_FILE_BYTES);
    const files = Array.from({ length: fits + 1 }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: atPerFileLimit,
    }));
    expect(
      analysisRequestSchema.safeParse(request(files.slice(0, fits))).success,
    ).toBe(true);
    expect(analysisRequestSchema.safeParse(request(files)).success).toBe(false);
  });
});
