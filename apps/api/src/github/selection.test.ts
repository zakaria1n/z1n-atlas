import { describe, expect, it } from "vitest";
import { selectRepositoryFiles } from "./selection";
describe("repository selection", () => {
  it("prioritizes project configuration and distributes limited coverage across directories", () => {
    const candidates = [
      ...Array.from({ length: 210 }, (_, index) => ({
        path: `frontend/src/file${index}.ts`,
        size: 1,
      })),
      { path: "backend/src/server.ts", size: 1 },
      { path: "package.json", size: 1 },
    ];
    const selected = selectRepositoryFiles(candidates);
    expect(selected).toHaveLength(200);
    expect(selected[0].path).toBe("package.json");
    expect(selected.some((item) => item.path === "backend/src/server.ts")).toBe(
      true,
    );
  });
  it("enforces the cumulative source-byte budget", () => {
    const selected = selectRepositoryFiles(
      Array.from({ length: 30 }, (_, index) => ({
        path: `src/f${index}.ts`,
        size: 250_000,
      })),
    );
    expect(selected).toHaveLength(20);
  });
});
