import { describe, expect, it } from "vitest";
import { providerErrorForStatus } from "./contracts";
import { providerRequestSchema } from "@z1n/contracts";
describe("provider boundaries", () => {
  it("rejects missing keys and header-injection characters", () => {
    expect(
      providerRequestSchema.safeParse({ provider: "openai", apiKey: "" })
        .success,
    ).toBe(false);
    expect(
      providerRequestSchema.safeParse({
        provider: "google",
        apiKey: "key\r\nheader",
      }).success,
    ).toBe(false);
    expect(
      providerRequestSchema.safeParse({ provider: "unknown", apiKey: "key" })
        .success,
    ).toBe(false);
  });
  it.each([
    [401, "INVALID_KEY"],
    [403, "FORBIDDEN"],
    [429, "RATE_LIMIT"],
    [500, "UNAVAILABLE"],
  ])("maps %s to %s", (status, code) => {
    const error = providerErrorForStatus(status as number);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("key-value");
  });
});
