import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
vi.mock("@/server/github/import-repository", () => ({
  GitHubImportError: class extends Error {},
  importGitHubRepository: vi.fn(async (repository: unknown) => ({
    repository,
    commit: "a".repeat(40),
    files: [],
    skipped: 0,
    truncated: false,
  })),
}));
const request = (body: string, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/repositories/import", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
describe("import endpoint", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects cross-origin and oversized requests", async () => {
    expect((await POST(request("{}", "https://example.com"))).status).toBe(403);
    expect((await POST(request("x".repeat(2049)))).status).toBe(413);
  });
  it("validates the repository and returns a non-cacheable result", async () => {
    expect(
      (await POST(request(JSON.stringify({ url: "https://evil.test/a/b" }))))
        .status,
    ).toBe(400);
    const result = await POST(
      request(JSON.stringify({ url: "https://github.com/a/b" })),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
});
