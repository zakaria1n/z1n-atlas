import { describe, expect, it } from "vitest";
import { rrfFuse } from "./rrf";

describe("reciprocal rank fusion", () => {
  it("combines both rankings with the reference constant k=60", () => {
    // k=60: rank 1 contributes 1/61, rank 2 1/62. An item found by both
    // lists outranks an item found once, wherever it appeared.
    const fused = rrfFuse(["a", "b", "c"], ["b", "d"], 5);
    expect(fused[0]).toBe("b"); // 1/62 + 1/61 beats a's single 1/61
    expect(fused).toContain("a");
    expect(fused.indexOf("a")).toBeLessThan(fused.indexOf("c"));
  });
  it("keeps distinct functions of one file separate", () => {
    const lexical = ["file.ts#create", "file.ts#save"];
    const semantic = ["file.ts#save", "file.ts#create"];
    const fused = rrfFuse(lexical, semantic, 5);
    expect(fused).toEqual(["file.ts#create", "file.ts#save"]);
  });
  it("caps the fused result at the requested limit", () => {
    const fused = rrfFuse(["a", "b", "c", "d"], ["e", "f", "g", "h"], 3);
    expect(fused.length).toBe(3);
  });
});
