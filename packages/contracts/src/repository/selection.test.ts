import { describe, expect, it } from "vitest";
import { MAX_SOURCE_FILES, MAX_SOURCE_TOTAL_BYTES } from "./limits";
import { selectRepositoryFiles, selectionTier } from "./selection";

const file = (path: string, size = 1) => ({ path, size });
const byPath = (a: { path: string }, b: { path: string }) =>
  a.path.localeCompare(b.path, "en");

describe("selection tier", () => {
  it.each([
    ["package.json", 0],
    ["apps/web/tsconfig.json", 0],
    ["src/app/page.tsx", 1],
    ["server/routes/user.ts", 1],
    ["src/__tests__/user.ts", 2],
    ["src/user.test.tsx", 2],
    ["e2e/checkout.spec.ts", 2],
    ["src/Button.stories.tsx", 2],
    ["src/generated/client.ts", 2],
    ["src/api.gen.ts", 2],
    ["src/types.d.ts", 2],
    ["backend/app/bookings.py", 1],
    ["services/notifications.py", 1],
    ["tests/test_bookings.py", 2],
    ["backend/app/test_users.py", 2],
    ["backend/conftest.py", 2],
    ["migrations/versions/0001_catalog.py", 2],
    ["README.md", 3],
    ["src/styles.css", 3],
  ])("ranks %s as tier %i", (path, tier) => {
    expect(selectionTier(path)).toBe(tier);
  });
});

describe("repository selection", () => {
  it("keeps every file when the repository fits the budget", () => {
    const candidates = [
      file("README.md"),
      file("package.json"),
      file("src/a.ts"),
      file("src/a.test.ts"),
    ];
    expect(selectRepositoryFiles(candidates)).toEqual(
      [...candidates].sort(byPath),
    );
  });
  it("spends a limited budget on manifests and application code before tests and documents", () => {
    const candidates = [
      ...Array.from({ length: 100 }, (_, i) =>
        file(`packages/p${i}/package.json`),
      ),
      ...Array.from({ length: 1500 }, (_, i) => file(`src/app/file${i}.ts`)),
      ...Array.from({ length: 600 }, (_, i) =>
        file(`src/__tests__/file${i}.test.ts`),
      ),
      ...Array.from({ length: 300 }, (_, i) => file(`docs/guide${i}.md`)),
    ];
    const selected = selectRepositoryFiles(candidates);
    expect(selected).toHaveLength(MAX_SOURCE_FILES);
    const count = (prefix: string) =>
      selected.filter((item) => item.path.startsWith(prefix)).length;
    expect(count("packages/")).toBe(100);
    expect(count("src/app/")).toBe(1500);
    expect(count("src/__tests__/")).toBe(400);
    expect(count("docs/")).toBe(0);
    expect(selected).toEqual([...selected].sort(byPath));
  });
  it("spreads coverage across directories instead of taking a prefix", () => {
    const candidates = Array.from({ length: 3000 }, (_, i) =>
      file(`d${Math.floor(i / 300)}/src/f${i}.ts`),
    );
    const selected = selectRepositoryFiles(candidates);
    expect(selected).toHaveLength(MAX_SOURCE_FILES);
    const perDirectory = new Map<string, number>();
    for (const item of selected) {
      const directory = item.path.split("/")[0];
      perDirectory.set(directory, (perDirectory.get(directory) ?? 0) + 1);
    }
    expect([...perDirectory.values()]).toEqual(
      Array.from({ length: 10 }, () => 200),
    );
  });
  it("enforces the cumulative source-byte budget", () => {
    const size = 250_000;
    const fits = Math.floor(MAX_SOURCE_TOTAL_BYTES / size);
    const selected = selectRepositoryFiles(
      Array.from({ length: fits + 10 }, (_, index) =>
        file(`src/f${index}.ts`, size),
      ),
    );
    expect(selected).toHaveLength(fits);
  });
});
