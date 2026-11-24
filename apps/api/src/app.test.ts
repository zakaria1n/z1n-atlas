import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app";
vi.mock("./analyzer/run-analysis", () => ({
  AnalysisError: class extends Error {},
  runAnalysis: vi.fn(async () => ({
    nodes: [],
    edges: [],
    evidence: [],
    unresolved: 0,
    unresolvedCalls: 0,
    notice: "No evidence.",
  })),
}));
vi.mock("./github/import-repository", () => ({
  GitHubImportError: class extends Error {},
  importGitHubRepository: vi.fn(async (repository) => ({
    repository,
    commit: "a".repeat(40),
    files: [],
    skipped: 0,
    truncated: false,
  })),
}));
vi.mock("./providers/discovery", () => ({
  createProviderAdapter: () => ({
    listModels: vi.fn(async () => ({
      models: [{ id: "model-a", label: "Model A", compatibility: "candidate" }],
      partial: false,
      notice: "Access is not guaranteed.",
    })),
  }),
}));
let app: FastifyInstance;
beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});
const request = (payload: unknown, origin = "http://localhost:3000") =>
  app.inject({
    method: "POST",
    url: "/api/analysis",
    headers: { origin, "content-type": "application/json" },
    payload,
  });
describe("analysis HTTP boundary", () => {
  it("rejects remote origins, unconsented local source and invalid paths", async () => {
    expect(
      (
        await request(
          { files: [], origin: "local", consent: true },
          "https://hostile.example",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await request({ files: [], origin: "local", consent: false }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await request({
          files: [{ path: "../secret.ts", content: "x" }],
          origin: "github",
          consent: false,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("returns a validated non-cacheable result when consent is present", async () => {
    const response = await request({
      files: [{ path: "a.ts", content: "export const x = 1;" }],
      origin: "local",
      consent: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().edges).toEqual([]);
  });
});

describe("repository HTTP boundary", () => {
  it("rejects unsafe URLs and returns a validated public snapshot", async () => {
    const headers = {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    };
    const bad = await app.inject({
      method: "POST",
      url: "/api/repositories/import",
      headers,
      payload: { url: "https://example.com/a/b" },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "POST",
      url: "/api/repositories/import",
      headers,
      payload: { url: "https://github.com/example/repo" },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().repository.url).toBe("https://github.com/example/repo");
  });
});

describe("provider HTTP boundary", () => {
  it("rejects missing keys and returns only normalized discovery data", async () => {
    const headers = {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    };
    const bad = await app.inject({
      method: "POST",
      url: "/api/providers/models",
      headers,
      payload: { provider: "openai", apiKey: "" },
    });
    expect(bad.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/models",
      headers,
      payload: { provider: "openai", apiKey: "test-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("test-key");
    expect(response.json().models[0].id).toBe("model-a");
  });
});
