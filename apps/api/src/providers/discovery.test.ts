import { describe, expect, it, vi } from "vitest";
import { createProviderAdapter } from "./discovery";
import { ProviderError } from "./contracts";
const fakeKey = "test-secret-key";
function fake(payload: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}
describe("provider model discovery", () => {
  it("filters OpenAI candidates and keeps the key out of the URL", async () => {
    const fetcher = fake({
      data: [
        { id: "gpt-4.1" },
        { id: "gpt-audio" },
        { id: "text-embedding-3" },
        { id: "o3" },
      ],
    });
    const adapter = createProviderAdapter("openai", fetcher);
    const result = await adapter.listModels(fakeKey);
    expect(result.models.map((model) => model.id)).toEqual(["gpt-4.1", "o3"]);
    expect(result.models[0].compatibility).toBe("candidate");
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).not.toContain(fakeKey);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${fakeKey}`,
    );
    expect(init?.redirect).toBe("error");
  });
  it("uses Gemini capability metadata and reports pagination", async () => {
    const fetcher = fake({
      models: [
        {
          name: "models/gemini-text",
          displayName: "Gemini",
          supportedGenerationMethods: ["generateContent"],
          supportedOutputTypes: ["text"],
        },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        {
          name: "models/image",
          supportedGenerationMethods: ["generateContent"],
          supportedOutputTypes: ["image"],
        },
      ],
      nextPageToken: "next",
    });
    const result = await createProviderAdapter("google", fetcher).listModels(
      fakeKey,
    );
    expect(result.models.map((model) => model.id)).toEqual(["gemini-text"]);
    expect(result.partial).toBe(true);
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).not.toContain(fakeKey);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(fakeKey);
  });
  it("lists Claude candidates and preserves partial coverage", async () => {
    const fetcher = fake({
      data: [
        { id: "claude-test", display_name: "Claude" },
        { id: "claude-retired", lifecycle: "retired" },
        { id: "other" },
      ],
      has_more: true,
    });
    const result = await createProviderAdapter("anthropic", fetcher).listModels(
      fakeKey,
    );
    expect(result.models.map((model) => model.id)).toEqual(["claude-test"]);
    expect(result.partial).toBe(true);
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).not.toContain(fakeKey);
    expect(new Headers(init?.headers).get("anthropic-version")).toBe(
      "2026-10-21",
    );
  });
  it("maps errors without exposing provider bodies or secrets", async () => {
    const adapter = createProviderAdapter(
      "openai",
      fake({ error: fakeKey }, 401),
    );
    await expect(adapter.listModels(fakeKey)).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
    try {
      await adapter.listModels(fakeKey);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain(fakeKey);
    }
  });
  it("rejects oversized responses", async () => {
    const fetcher = fake({ data: [], padding: "x".repeat(1_000_001) });
    await expect(
      createProviderAdapter("openai", fetcher).listModels(fakeKey),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
