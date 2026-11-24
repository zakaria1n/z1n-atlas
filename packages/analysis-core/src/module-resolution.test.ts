import { ts, type CompilerOptions } from "ts-morph";
import { describe, expect, it } from "vitest";
import { createModuleResolver } from "./module-resolution";

const files = [
  { path: "tsconfig.json", content: "" },
  { path: "src/a.ts", content: "" },
  { path: "src/b.tsx", content: "" },
  { path: "src/c.js", content: "" },
  { path: "src/dir/index.ts", content: "" },
  { path: "src/pkg/package.json", content: '{"types":"types.d.ts"}' },
  { path: "src/pkg/types.d.ts", content: "" },
];
const options = {
  allowJs: true,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  baseUrl: "/workspace",
  paths: { "@/*": ["src/*"] },
} as CompilerOptions;

describe("module resolution", () => {
  const resolve = createModuleResolver(files, options);
  it("resolves relative specifiers to imported files of supported types", () => {
    expect(resolve("./a", "src/dir/index.ts")).toBeNull();
    expect(resolve("../a", "src/dir/index.ts")).toBe("src/a.ts");
    expect(resolve("../b", "src/dir/index.ts")).toBe("src/b.tsx");
    expect(resolve("../c", "src/dir/index.ts")).toBe("src/c.js");
    expect(resolve("./dir", "src/a.ts")).toBe("src/dir/index.ts");
    expect(resolve("./dir/index", "src/a.ts")).toBe("src/dir/index.ts");
  });
  it("follows a package manifest that is part of the import", () => {
    expect(resolve("./pkg", "src/a.ts")).toBe("src/pkg/types.d.ts");
  });
  it("applies root path aliases", () => {
    expect(resolve("@/dir", "src/a.ts")).toBe("src/dir/index.ts");
  });
  it("never resolves packages or files outside the import", () => {
    expect(resolve("react", "src/a.ts")).toBeNull();
    expect(resolve("react-dom/dom", "src/a.ts")).toBeNull();
    expect(resolve("fs", "src/a.ts")).toBeNull();
    expect(resolve("../outside", "src/a.ts")).toBeNull();
    expect(resolve("./missing", "src/a.ts")).toBeNull();
  });
  it("matches file names case-sensitively on every platform", () => {
    expect(resolve("./A", "src/dir/index.ts")).toBeNull();
  });
});
