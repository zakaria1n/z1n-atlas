import { isEligiblePath } from "@z1n/contracts";
import { describe, expect, it, vi } from "vitest";
import { GitHubImportError, importGitHubRepository } from "./import-repository";

const repo = {
  owner: "example",
  name: "project",
  url: "https://github.com/example/project",
};
const sha = "a".repeat(40);
const responses = (values: unknown[]) =>
  vi.fn(
    async () => new Response(JSON.stringify(values.shift()), { status: 200 }),
  ) as unknown as typeof fetch;

describe("repository filtering", () => {
  it.each([
    "../secret.ts",
    "src/../../main.ts",
    "src\\main.ts",
    ".env",
    "src/.env.local",
    "node_modules/pkg/index.ts",
    "secrets/config.ts",
    "src/api-key.ts",
    "dist/app.js",
    "src/image.png",
  ])("excludes %s", (path) => expect(isEligiblePath(path)).toBe(false));
  it.each(["src/main.ts", "README.md", "src/app.tsx"])("allows %s", (path) =>
    expect(isEligiblePath(path)).toBe(true),
  );
});

describe("GitHub importer", () => {
  it("stops further requests when the caller cancels", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return new Response(
        JSON.stringify({ private: false, default_branch: "main" }),
      );
    });
    await expect(
      importGitHubRepository(repo, fetcher, controller.signal),
    ).rejects.toBeInstanceOf(GitHubImportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("imports bounded text and reports excluded files and a truncated tree", async () => {
    const fetcher = responses([
      { private: false, default_branch: "main" },
      { sha },
      {
        truncated: true,
        tree: [
          { type: "blob", mode: "100644", path: "src/a.ts", size: 3, sha },
          { type: "blob", mode: "100644", path: ".env", size: 3, sha },
          { type: "blob", mode: "120000", path: "link.ts", size: 3, sha },
        ],
      },
      { encoding: "base64", size: 3, content: "YWJj" },
    ]);
    const snapshot = await importGitHubRepository(repo, fetcher);
    expect(snapshot.files).toEqual([
      { path: "src/a.ts", size: 3, content: "abc" },
    ]);
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.commit).toBe(sha);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("caps a large repository and reports omitted files", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      type: "blob",
      mode: "100644",
      path: `src/file${i}.ts`,
      size: 3,
      sha,
    }));
    const fetcher = responses([
      { private: false, default_branch: "main" },
      { sha },
      { truncated: false, tree: entries },
      ...Array.from({ length: 25 }, () => ({
        encoding: "base64",
        size: 3,
        content: "YWJj",
      })),
    ]);
    const snapshot = await importGitHubRepository(repo, fetcher);
    expect(snapshot.files).toHaveLength(25);
    expect(snapshot.skipped).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(28);
  });
  it("surfaces rate limits without returning upstream content", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("sensitive", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    ) as unknown as typeof fetch;
    await expect(importGitHubRepository(repo, fetcher)).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });
  it("reports missing repositories", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(importGitHubRepository(repo, fetcher)).rejects.toBeInstanceOf(
      GitHubImportError,
    );
  });
});
