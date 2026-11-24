import { describe, expect, it, vi } from "vitest";
import { testModel } from "./test-model";

describe("model generation checks", () => {
  it.each([
    [
      "openai",
      "https://api.openai.com/v1/responses",
      {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "OK" }] },
        ],
      },
    ],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/models/demo:generateContent",
      { candidates: [{ content: { parts: [{ text: "OK" }] } }] },
    ],
    [
      "anthropic",
      "https://api.anthropic.com/v1/messages",
      { content: [{ type: "text", text: "OK" }] },
    ],
  ] as const)(
    "sends a bounded check to %s and validates text",
    async (provider, url, response) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(response)));
      await expect(
        testModel(
          { provider, model: "demo", apiKey: "fake-key" },
          undefined,
          fetcher,
        ),
      ).resolves.toBeUndefined();
      const [actualUrl, options] = fetcher.mock.calls[0];
      expect(actualUrl).toBe(url);
      expect(actualUrl).not.toContain("fake-key");
      expect(options?.method).toBe("POST");
      expect(String(options?.body)).not.toContain("fake-key");
    },
  );
  it("rejects empty output and hides provider error bodies", async () => {
    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ content: [] })));
    await expect(
      testModel(
        { provider: "anthropic", model: "demo", apiKey: "fake-key" },
        undefined,
        empty,
      ),
    ).rejects.toThrow("did not return text");
    const bad = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("fake-key", { status: 401 }));
    await expect(
      testModel(
        { provider: "anthropic", model: "demo", apiKey: "fake-key" },
        undefined,
        bad,
      ),
    ).rejects.not.toThrow("fake-key");
  });
});
