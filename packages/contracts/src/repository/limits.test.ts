import { describe, expect, it } from "vitest";
import { analysisRequestSchema } from "../http";
describe("source bounds", () => {
  const request = (files: { path: string; content: string }[]) => ({
    files,
    origin: "local" as const,
    consent: true,
  });
  it("accepts 200 files but rejects 201 and duplicate paths", () => {
    const files = Array.from({ length: 201 }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: "x",
    }));
    expect(
      analysisRequestSchema.safeParse(request(files.slice(0, 200))).success,
    ).toBe(true);
    expect(analysisRequestSchema.safeParse(request(files)).success).toBe(false);
    expect(
      analysisRequestSchema.safeParse(request([files[0], files[0]])).success,
    ).toBe(false);
  });
  it("enforces per-file and total limits by UTF-8 bytes", () => {
    expect(
      analysisRequestSchema.safeParse(
        request([{ path: "x.ts", content: "é".repeat(128_001) }]),
      ).success,
    ).toBe(false);
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: "x".repeat(250_000),
    }));
    expect(analysisRequestSchema.safeParse(request(files)).success).toBe(false);
  });
});
