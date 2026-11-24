import { describe, expect, it } from "vitest";
import { parseGitHubRepository } from "./github-url";

describe("parseGitHubRepository", () => {
  it("normalizes a public repository URL", () => {
    expect(
      parseGitHubRepository(" https://github.com/octocat/Hello-World.git/ "),
    ).toEqual({
      owner: "octocat",
      name: "Hello-World",
      url: "https://github.com/octocat/Hello-World",
    });
  });
  it.each([
    "http://github.com/a/b",
    "https://github.com.evil.test/a/b",
    "https://user:pass@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "https://github.com/a/b/tree/main",
    "https://github.com/a/%2e%2e",
    "https://github.com/a/b//",
    "https://github.com/a",
    "https://-bad/b",
  ])("rejects %s", (input) => {
    expect(parseGitHubRepository(input)).toBeNull();
  });
});
