import { describe, expect, it } from "vitest";
import { compilerOptions } from "./compiler-options";
describe("source compiler configuration", () => {
  it("ignores path mappings outside the in-memory workspace", () => {
    const { options } = compilerOptions([
      {
        path: "tsconfig.json",
        content:
          '{"compilerOptions":{"baseUrl":"../../outside","paths":{"bad/*":["../../secret/*"],"safe/*":["src/*"]}}}',
      },
    ]);
    expect(options.baseUrl).toBe("/workspace");
    expect(options.paths?.["bad/*"]).toBeUndefined();
    expect(options.paths?.["safe/*"]).toEqual(["src/*"]);
  });
});
