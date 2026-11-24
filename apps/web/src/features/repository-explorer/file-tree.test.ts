import { describe, expect, it } from "vitest";
import { buildFileTree } from "./file-tree";
const files = ["src/routes/index.ts", "README.md", "src/app.ts"].map(
  (path) => ({ path, content: "", size: 0 }),
);
describe("repository tree", () => {
  it("groups files under stable relative paths", () => {
    expect(buildFileTree(files)).toEqual([
      { kind: "file", name: "README.md", path: "README.md" },
      {
        kind: "directory",
        name: "src",
        path: "src",
        children: [
          { kind: "file", name: "app.ts", path: "src/app.ts" },
          {
            kind: "directory",
            name: "routes",
            path: "src/routes",
            children: [
              { kind: "file", name: "index.ts", path: "src/routes/index.ts" },
            ],
          },
        ],
      },
    ]);
  });
  it("filters by case-insensitive path while preserving parent folders", () => {
    expect(buildFileTree(files, "INDEX")).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        children: [
          {
            kind: "directory",
            name: "routes",
            path: "src/routes",
            children: [
              { kind: "file", name: "index.ts", path: "src/routes/index.ts" },
            ],
          },
        ],
      },
    ]);
  });
});
