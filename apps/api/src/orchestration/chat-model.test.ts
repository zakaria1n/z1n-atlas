import { describe, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createChatModel, providerErrorFrom } from "./chat-model";
import { ProviderError } from "../providers/contracts";

describe("chat model factory", () => {
  it("constructs the official integration for each provider", () => {
    expect(
      createChatModel({ provider: "openai", apiKey: "k", model: "m" }),
    ).toBeInstanceOf(ChatOpenAI);
    expect(
      createChatModel({ provider: "anthropic", apiKey: "k", model: "m" }),
    ).toBeInstanceOf(ChatAnthropic);
    expect(
      createChatModel({ provider: "google", apiKey: "k", model: "m" }),
    ).toBeInstanceOf(ChatGoogleGenerativeAI);
  });
  it("disables automatic retries so the request budget stays deterministic", () => {
    for (const provider of ["openai", "anthropic", "google"] as const) {
      const model = createChatModel({
        provider,
        apiKey: "k",
        model: "m",
        maxOutputTokens: 1600,
      });
      expect(model.caller.maxRetries).toBe(0);
    }
  });
});

describe("typed provider error mapping", () => {
  it("maps integration status codes onto the product error codes", () => {
    expect(providerErrorFrom({ status: 401 }).code).toBe("INVALID_KEY");
    expect(providerErrorFrom({ status: 403 }).code).toBe("FORBIDDEN");
    expect(providerErrorFrom({ response: { status: 429 } }).code).toBe(
      "RATE_LIMIT",
    );
    expect(providerErrorFrom({ status: 404 }).code).toBe("UNSUPPORTED_MODEL");
    expect(providerErrorFrom({ status: 503 }).code).toBe("UNAVAILABLE");
  });
  it("maps cancellations and unknown failures without copying provider text", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    const unavailable = providerErrorFrom(abort);
    expect(unavailable.code).toBe("UNAVAILABLE");
    const other = providerErrorFrom(
      new Error("secret-body.invalid_api_key泄露 fake-key"),
    );
    expect(other.code).toBe("INVALID_RESPONSE");
    expect(other.message).not.toContain("fake-key");
    expect(other.message).not.toContain("invalid_api_key");
  });
  it("keeps an existing ProviderError unchanged", () => {
    const original = new ProviderError("RATE_LIMIT", "Slow down.");
    expect(providerErrorFrom(original)).toBe(original);
  });
});
