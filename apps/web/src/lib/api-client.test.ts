import { afterEach, describe, expect, it, vi } from "vitest";
import { askRepository } from "./api-client";
const request = {
  provider: "openai" as const,
  apiKey: "fake-key",
  model: "demo",
  question: "Where is login?",
  origin: "local" as const,
  consent: true,
  providerConsent: true as const,
  files: [{ path: "src/login.ts", content: "export function login() {}" }],
};
afterEach(() => vi.unstubAllGlobals());
describe("answer citation boundary", () => {
  it("accepts a source citation that matches the selected file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              claims: [
                {
                  text: "login is exported",
                  citations: [
                    {
                      id: "one",
                      filePath: "src/login.ts",
                      startLine: 1,
                      endLine: 1,
                      snippet: "export function login()",
                    },
                  ],
                },
              ],
              uncertainties: [],
            }),
          ),
      ),
    );
    await expect(askRepository(request)).resolves.toMatchObject({
      claims: [{ text: "login is exported" }],
    });
  });
  it("rejects fabricated lines and paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              claims: [
                {
                  text: "fake",
                  citations: [
                    {
                      id: "one",
                      filePath: "src/login.ts",
                      startLine: 2,
                      endLine: 2,
                      snippet: "fake",
                    },
                  ],
                },
              ],
              uncertainties: [],
            }),
          ),
      ),
    );
    await expect(askRepository(request)).rejects.toThrow(
      "invalid source citation",
    );
  });
});
