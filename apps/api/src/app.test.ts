import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app";
import { createChatModel } from "./orchestration/chat-model";
import { runAnalysis } from "./analyzer/run-analysis";
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
    inventory: [],
    indexTruncated: false,
    skipped: 0,
    truncated: false,
  })),
  readGitHubFile: vi.fn(async (_repository, _commit, path) => ({
    path,
    size: 3,
    content: "abc",
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
vi.mock("./providers/test-model", () => ({
  testModel: vi.fn(async () => undefined),
}));
vi.mock("./providers/generate-answer", () => ({
  generateAnswer: vi.fn(async (_input, context) => ({
    claims: [
      {
        text: "The source mentions login.",
        evidenceIds: [context.evidence[0].id],
      },
    ],
    uncertainties: [],
  })),
}));
vi.mock("./orchestration/chat-model", () => ({
  createChatModel: vi.fn(() => ({
    // The integration fails immediately, so the journey must come back as
    // the honest provider-failure result instead of a static path.
    bindTools: () => {
      throw new Error("simulated provider outage");
    },
  })),
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
  it("starts a bounded job, exposes status and supports cleanup", async () => {
    const isolated = await createApp();
    try {
      const headers = { origin: "http://localhost:3000" };
      const started = await isolated.inject({
        method: "POST",
        url: "/api/analysis/jobs",
        headers,
        payload: {
          files: [{ path: "a.ts", content: "export const x = 1;" }],
          origin: "local",
          consent: true,
        },
      });
      expect(started.statusCode).toBe(202);
      const url = `/api/analysis/jobs/${started.json().jobId}`;
      const rejected = await isolated.inject({
        method: "GET",
        url,
        headers: { origin: "https://hostile.example" },
      });
      expect(rejected.statusCode).toBe(403);
      await vi.waitFor(async () => {
        const response = await isolated.inject({ method: "GET", url, headers });
        expect(response.json().status).toBe("complete");
        expect(response.json().graph.analysisId).toBeTruthy();
      });
      expect(
        (await isolated.inject({ method: "DELETE", url, headers })).statusCode,
      ).toBe(204);
      expect(
        (await isolated.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(404);
    } finally {
      await isolated.close();
    }
  });
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
  it("only permits bounded public file inspection at a pinned commit", async () => {
    const headers = { origin: "http://localhost:3000" };
    const payload = {
      url: "https://github.com/example/repo",
      commit: "a".repeat(40),
      path: "src/a.ts",
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/repositories/file",
      headers,
      payload: { ...payload, path: "../.env" },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({
      method: "POST",
      url: "/api/repositories/file",
      headers,
      payload,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ path: "src/a.ts", size: 3, content: "abc" });
  });
  it("rate-limits file inspection per process and checks the request origin", async () => {
    const isolated = await createApp();
    try {
      const payload = {
        url: "https://github.com/example/repo",
        commit: "a".repeat(40),
        path: "src/a.ts",
      };
      const url = "/api/repositories/file";
      let status = 0;
      for (let attempt = 0; attempt <= 60; attempt++)
        status = (
          await isolated.inject({
            method: "POST",
            url,
            headers: { origin: "http://localhost:3000" },
            payload,
          })
        ).statusCode;
      expect(status).toBe(429);
      const rejected = await isolated.inject({
        method: "POST",
        url,
        headers: { origin: "https://hostile.example" },
        payload,
      });
      expect(rejected.statusCode).toBe(403);
    } finally {
      await isolated.close();
    }
  });
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
  it("validates model checks and returns no key", async () => {
    const headers = {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers,
      payload: { provider: "google", apiKey: "fake-key", model: "../bad" },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers,
      payload: { provider: "google", apiKey: "fake-key", model: "demo" },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true });
    expect(valid.body).not.toContain("fake-key");
  });
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

describe("chat HTTP boundary", () => {
  it("returns citations drawn from server-selected source", async () => {
    const isolated = await createApp();
    try {
      const response = await isolated.inject({
        method: "POST",
        url: "/api/chat",
        headers: { origin: "http://localhost:3000" },
        payload: {
          ai: {
            provider: "openai",
            apiKey: "fake-key",
            model: "demo",
            providerConsent: true,
          },
          question: "Where is login?",
          files: [{ path: "a.ts", content: "export const login = 1;" }],
          origin: "local",
          consent: true,
          providerConsent: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().claims[0].citations[0]).toMatchObject({
        filePath: "a.ts",
        startLine: 1,
      });
      expect(response.body).not.toContain("fake-key");
    } finally {
      await isolated.close();
    }
  });
  it("requires provider consent and abstains without matching evidence", async () => {
    const headers = {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    };
    const payload = {
      ai: {
        provider: "openai",
        apiKey: "fake-key",
        model: "demo",
        providerConsent: true,
      },
      question: "Where is payment?",
      files: [{ path: "a.ts", content: "export const x = 1;" }],
      origin: "local",
      consent: true,
      providerConsent: false,
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers,
      payload: { ...payload, providerConsent: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().claims).toEqual([]);
    expect(response.body).not.toContain("fake-key");
  });
});
describe("server-managed AI boundary", () => {
  const withEnvironment = async (environment, run) => {
    const saved: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(environment)) {
      saved[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return await run();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
  it("reports availability without exposing the key", async () => {
    const disabled = await withEnvironment(
      { ENABLE_DEV_LLM_KEYS: undefined },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "GET",
            url: "/api/ai/status",
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(disabled.json().available).toBe(false);
    const result = await withEnvironment(
      {
        ENABLE_DEV_LLM_KEYS: "true",
        OPENAI_API_KEY: "server-secret",
        OPENAI_DEFAULT_MODEL: "demo",
      },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "GET",
            url: "/api/ai/status",
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(result.json().available).toBe(true);
    expect(result.json().provider).toBe("openai");
    expect(result.json().model).toBe("demo");
    expect(result.body).not.toContain("server-secret");
  });
  it("is never available in production, whatever the flags say", async () => {
    const result = await withEnvironment(
      {
        ENABLE_DEV_LLM_KEYS: "true",
        OPENAI_API_KEY: "server-secret",
        NODE_ENV: "production",
      },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "GET",
            url: "/api/ai/status",
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(result.json().available).toBe(false);
  });
  it("serves chat with the backend key when opted in", async () => {
    const response = await withEnvironment(
      {
        ENABLE_DEV_LLM_KEYS: "true",
        OPENAI_API_KEY: "server-secret",
        OPENAI_DEFAULT_MODEL: "demo",
      },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "POST",
            url: "/api/chat",
            headers: { origin: "http://localhost:3000" },
            payload: {
              serverAi: true,
              providerConsent: true,
              question: "Where is login?",
              files: [{ path: "a.ts", content: "export const login = 1;" }],
              origin: "local",
              consent: true,
            },
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("server-secret");
  });
  it("rejects server-managed chat when disabled", async () => {
    const response = await withEnvironment(
      { ENABLE_DEV_LLM_KEYS: undefined },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "POST",
            url: "/api/chat",
            headers: { origin: "http://localhost:3000" },
            payload: {
              serverAi: true,
              providerConsent: true,
              question: "Where is login?",
              files: [{ path: "a.ts", content: "export const login = 1;" }],
              origin: "local",
              consent: true,
            },
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("Server-managed AI");
  });
  it("requires consent for server-managed journeys", async () => {
    const response = await withEnvironment(
      { ENABLE_DEV_LLM_KEYS: "true", OPENAI_API_KEY: "server-secret" },
      async () => {
        const isolated = await createApp();
        try {
          return await isolated.inject({
            method: "POST",
            url: "/api/journeys",
            headers: { origin: "http://localhost:3000" },
            payload: {
              serverAi: true,
              files: [{ path: "a.ts", content: "export function login() {}" }],
              origin: "local",
              consent: true,
              goal: "login",
            },
          });
        } finally {
          await isolated.close();
        }
      },
    );
    expect(response.statusCode).toBe(400);
  });
});
describe("journey HTTP boundary", () => {
  it("reuses only the matching analysis for subsequent journey and chat requests", async () => {
    vi.mocked(runAnalysis).mockClear();
    const isolated = await createApp();
    try {
      const headers = { origin: "http://localhost:3000" };
      const files = [{ path: "a.ts", content: "export function login() {}" }];
      const analysis = await isolated.inject({
        method: "POST",
        url: "/api/analysis",
        headers,
        payload: { files, origin: "local", consent: true },
      });
      expect(analysis.statusCode).toBe(200);
      const analysisId: string = analysis.json().analysisId;
      const journey = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers,
        payload: {
          files,
          origin: "local",
          consent: true,
          goal: "login",
          analysisId,
        },
      });
      expect(journey.statusCode).toBe(200);
      const chat = await isolated.inject({
        method: "POST",
        url: "/api/chat",
        headers,
        payload: {
          files,
          origin: "local",
          consent: true,
          providerConsent: true,
          ai: {
            provider: "openai",
            apiKey: "fake-key",
            model: "demo",
            providerConsent: true,
          },
          question: "login",
          analysisId,
        },
      });
      expect(chat.statusCode).toBe(200);
      expect(runAnalysis).toHaveBeenCalledTimes(1);
      const changed = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers,
        payload: {
          files: [{ path: "a.ts", content: "changed" }],
          origin: "local",
          consent: true,
          goal: "login",
          analysisId,
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(runAnalysis).toHaveBeenCalledTimes(2);
    } finally {
      await isolated.close();
    }
  });
  it("requires consent before an AI-guided journey", async () => {
    const isolated = await createApp();
    try {
      const payload = {
        goal: "login",
        files: [{ path: "a.ts", content: "export function login() {}" }],
        origin: "local",
        consent: true,
        ai: {
          provider: "openai",
          apiKey: "fake-key",
          model: "demo",
          providerConsent: false,
        },
      };
      const invalid = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers: { origin: "http://localhost:3000" },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
      expect(createChatModel).not.toHaveBeenCalled();
      const valid = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers: { origin: "http://localhost:3000" },
        payload: { ...payload, ai: { ...payload.ai, providerConsent: true } },
      });
      expect(valid.statusCode).toBe(200);
      expect(createChatModel).toHaveBeenCalledOnce();
      expect(valid.json().mode).toBe("ai");
      expect(valid.json().nodeIds).toEqual([]);
      expect(valid.json().uncertainties[0].toLowerCase()).toContain("model");
      expect(valid.body).not.toContain("fake-key");
    } finally {
      await isolated.close();
    }
  });
  it("requires local consent and returns an explicit unknown for an empty graph", async () => {
    const isolated = await createApp();
    try {
      const payload = {
        goal: "registration",
        files: [{ path: "a.ts", content: "export const x = 1;" }],
        origin: "local",
        consent: false,
      };
      const invalid = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers: { origin: "http://localhost:3000" },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
      const response = await isolated.inject({
        method: "POST",
        url: "/api/journeys",
        headers: { origin: "http://localhost:3000" },
        payload: { ...payload, consent: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().nodeIds).toEqual([]);
      expect(response.json().uncertainties.length).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });
});
