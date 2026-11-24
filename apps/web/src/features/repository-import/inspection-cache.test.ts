import { describe, expect, it, vi } from "vitest";
import type { SourceFile } from "./repository-session";
import { cacheInspections } from "./inspection-cache";

const file = (path: string, content: string): SourceFile => ({
  path,
  size: content.length,
  content,
});
function reader(content = "body") {
  return vi.fn(async (path: string) => file(path, content));
}

describe("inspection cache", () => {
  it("reads a path once and reuses the result afterwards", async () => {
    const read = reader();
    const cached = cacheInspections(read);
    expect(await cached("a.ts")).toEqual(file("a.ts", "body"));
    expect(await cached("a.ts")).toEqual(file("a.ts", "body"));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("evicts the least recently used entry beyond the entry limit", async () => {
    const read = reader();
    const cached = cacheInspections(read, { maxEntries: 2 });
    await cached("a.ts");
    await cached("b.ts");
    await cached("a.ts");
    await cached("c.ts");
    expect(read).toHaveBeenCalledTimes(3);
    await cached("c.ts");
    await cached("a.ts");
    expect(read).toHaveBeenCalledTimes(3);
    await cached("b.ts");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("keeps the retained size within the byte limit", async () => {
    const read = reader("x".repeat(600));
    const cached = cacheInspections(read, { maxEntries: 10, maxBytes: 1000 });
    await cached("a.ts");
    await cached("b.ts");
    await cached("c.ts");
    await cached("c.ts");
    expect(read).toHaveBeenCalledTimes(3);
    await cached("b.ts");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("does not retain a file that alone exceeds the byte limit", async () => {
    const read = reader("x".repeat(2000));
    const cached = cacheInspections(read, { maxBytes: 1000 });
    await cached("big.ts");
    await cached("big.ts");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not cache a failed read", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    const cached = cacheInspections(read);
    await expect(cached("a.ts")).rejects.toThrow("offline");
    await expect(cached("a.ts")).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
