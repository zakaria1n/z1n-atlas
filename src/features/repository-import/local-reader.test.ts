import { describe, expect, it, vi } from "vitest";
import { readLocalFiles } from "./local-reader";

type Item = { path: string; file: () => Promise<File> };
async function* source(items: Item[]): AsyncGenerator<Item> {
  yield* items;
}
const make = (path: string, text: string): Item => ({
  path,
  file: async () => new File([text], path),
});

describe("local source selection", () => {
  it("filters sensitive paths before opening files and preserves original content", async () => {
    const secret = vi.fn(async () => new File(["secret"], ".env"));
    const original = new File(["export const value = 1;"], "main.ts");
    const result = await readLocalFiles(
      source([
        { path: ".env", file: secret },
        { path: "src/main.ts", file: async () => original },
      ]),
    );
    expect(secret).not.toHaveBeenCalled();
    expect(result.files).toEqual([
      {
        path: "src/main.ts",
        size: original.size,
        content: "export const value = 1;",
      },
    ]);
    expect(await original.text()).toBe("export const value = 1;");
  });
  it("caps selection and marks incomplete coverage", async () => {
    const result = await readLocalFiles(
      source(
        Array.from({ length: 30 }, (_, index) =>
          make(`src/file${index}.ts`, "ok"),
        ),
      ),
    );
    expect(result.files).toHaveLength(25);
    expect(result.skipped).toBe(5);
    expect(result.truncated).toBe(true);
  });
  it("excludes oversized and binary source", async () => {
    const result = await readLocalFiles(
      source([make("large.ts", "x".repeat(100001)), make("binary.ts", "a\0b")]),
    );
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toBe(2);
  });
});
