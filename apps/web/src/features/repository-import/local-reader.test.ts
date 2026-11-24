import { describe, expect, it, vi } from "vitest";
import { MAX_SOURCE_FILES } from "@z1n/contracts";
import { directoryFiles, readLocalFiles, type Directory } from "./local-reader";

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
    const total = MAX_SOURCE_FILES + 5;
    const result = await readLocalFiles(
      source(
        Array.from({ length: total }, (_, index) =>
          make(`src/file${index}.ts`, "ok"),
        ),
      ),
    );
    expect(result.files).toHaveLength(MAX_SOURCE_FILES);
    expect(result.skipped).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.indexTruncated).toBe(false);
    expect(result.inventory).toHaveLength(total);
    const extra = result.inventory.find(
      (item) => !result.files.some((file) => file.path === item.path),
    )!;
    await expect(result.readFile(extra.path)).resolves.toEqual({
      path: extra.path,
      size: 2,
      content: "ok",
    });
  });
  it("excludes oversized and binary source from analysis but keeps it inspectable", async () => {
    const result = await readLocalFiles(
      source([make("large.ts", "x".repeat(256001)), make("binary.ts", "a\0b")]),
    );
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toBe(2);
    await expect(result.readFile("large.ts")).resolves.toMatchObject({
      size: 256001,
    });
    await expect(result.readFile("binary.ts")).rejects.toThrow(
      "not supported text",
    );
    await expect(result.readFile("missing.ts")).rejects.toThrow(
      "not part of the imported selection",
    );
  });
  it("leaves files above the inspection limit out of the index", async () => {
    const result = await readLocalFiles(
      source([make("huge.ts", "x".repeat(1000001)), make("src/a.ts", "ok")]),
    );
    expect(result.inventory.map((item) => item.path)).toEqual(["src/a.ts"]);
    expect(result.skipped).toBe(1);
  });
  it("stops indexing at the configured bound and reports an incomplete index", async () => {
    const result = await readLocalFiles(
      source(
        Array.from({ length: 6 }, (_, index) => make(`f${index}.ts`, "ok")),
      ),
      { limits: { maxIndexed: 4 } },
    );
    expect(result.inventory).toHaveLength(4);
    expect(result.files).toHaveLength(4);
    expect(result.indexTruncated).toBe(true);
    expect(result.truncated).toBe(true);
  });
  it("stops scanning at the entry bound without indexing later files", async () => {
    const result = await readLocalFiles(
      source([
        make("assets/a.png", "x"),
        make("assets/b.png", "x"),
        make("src/late.ts", "ok"),
      ]),
      { limits: { maxEntries: 2 } },
    );
    expect(result.inventory).toEqual([]);
    expect(result.indexTruncated).toBe(true);
  });
  it("cancels without returning a selection", async () => {
    const controller = new AbortController();
    async function* cancelling(items: Item[]) {
      for (const item of items) {
        yield item;
        controller.abort();
      }
    }
    await expect(
      readLocalFiles(cancelling([make("a.ts", "ok"), make("b.ts", "ok")]), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("walks nested folders and refuses excessive depth", async () => {
    const leaf: Directory = {
      kind: "directory",
      name: "leaf",
      async *values() {
        yield {
          kind: "file",
          name: "a.ts",
          getFile: async () => new File(["ok"], "a.ts"),
        };
      },
    };
    let nested: Directory = leaf;
    for (let depth = 0; depth < 25; depth++)
      nested = {
        kind: "directory",
        name: `level${depth}`,
        async *values() {
          yield nested;
        },
      };
    await expect(readLocalFiles(directoryFiles(nested))).rejects.toThrow(
      "nested too deeply",
    );
    const flat: Directory = {
      kind: "directory",
      name: "root",
      async *values() {
        yield {
          kind: "directory",
          name: "node_modules",
          async *values() {
            yield leaf;
          },
        };
        yield leaf;
      },
    };
    const result = await readLocalFiles(directoryFiles(flat));
    expect(result.inventory.map((item) => item.path)).toEqual(["leaf/a.ts"]);
  });
});
