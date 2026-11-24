import { isEligiblePath } from "@z1n/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubImportError,
  importErrorStatus,
  importGitHubRepository,
  readGitHubFile,
} from "./import-repository";

const repo = {
  owner: "example",
  name: "project",
  url: "https://github.com/example/project",
};
const sha = "a".repeat(40);
const responses = (values: unknown[]) =>
  vi.fn(async (input: string | URL | Request) => {
    const item = values.shift();
    if (String(input).startsWith("https://raw.githubusercontent.com/")) {
      const data = item as { content: string };
      return new Response(
        Buffer.from(data.content, "base64").toString("utf8"),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(item), { status: 200 });
  }) as unknown as typeof fetch;

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
    expect(snapshot.indexTruncated).toBe(true);
    expect(snapshot.inventory).toEqual([{ path: "src/a.ts", size: 3 }]);
    expect(snapshot.commit).toBe(sha);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("caps a large repository and reports omitted files", async () => {
    const entries = Array.from({ length: 205 }, (_, i) => ({
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
      ...Array.from({ length: 200 }, () => ({
        encoding: "base64",
        size: 3,
        content: "YWJj",
      })),
    ]);
    const snapshot = await importGitHubRepository(repo, fetcher);
    expect(snapshot.files).toHaveLength(200);
    expect(snapshot.inventory).toHaveLength(205);
    expect(snapshot.skipped).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(203);
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
  it("reads a pinned public file from the fixed raw host and rejects unsafe paths", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("abc"));
    await expect(
      readGitHubFile(repo, sha, "src/a.ts", fetcher),
    ).resolves.toEqual({ path: "src/a.ts", size: 3, content: "abc" });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://raw.githubusercontent.com/example/project/${sha}/src/a.ts`,
    );
    await expect(
      readGitHubFile(repo, sha, "../.env", fetcher),
    ).rejects.toBeInstanceOf(GitHubImportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("indexes inspectable files that are too large for analysis and skips the rest", async () => {
    const fetcher = responses([
      { private: false, default_branch: "main" },
      { sha },
      {
        truncated: false,
        tree: [
          { type: "blob", mode: "100644", path: "src/a.ts", size: 3, sha },
          {
            type: "blob",
            mode: "100644",
            path: "src/huge.ts",
            size: 1_000_001,
            sha,
          },
          {
            type: "blob",
            mode: "100644",
            path: "src/large.ts",
            size: 300_000,
            sha,
          },
        ],
      },
      { encoding: "base64", size: 3, content: "YWJj" },
    ]);
    const snapshot = await importGitHubRepository(repo, fetcher);
    expect(snapshot.files).toEqual([
      { path: "src/a.ts", size: 3, content: "abc" },
    ]);
    expect(snapshot.inventory).toEqual([
      { path: "src/a.ts", size: 3 },
      { path: "src/large.ts", size: 300_000 },
    ]);
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.indexTruncated).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("reports files that are not source text as unsupported", async () => {
    for (const body of ["a\0b", new Uint8Array([0x66, 0x6f, 0x80])]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      await expect(
        readGitHubFile(repo, sha, "src/a.ts", fetcher),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
  });
  it("maps import failures to accurate HTTP statuses", () => {
    expect(
      (
        [
          "NOT_FOUND",
          "RATE_LIMIT",
          "TOO_LARGE",
          "UNSUPPORTED",
          "UPSTREAM",
        ] as const
      ).map(importErrorStatus),
    ).toEqual([404, 429, 413, 415, 502]);
  });
});
