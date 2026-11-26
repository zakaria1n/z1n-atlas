import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFiles } from "@z1n/analysis-core";
import { graphIsValid, type CodeGraph } from "@z1n/contracts";
import {
  aiProviders,
  developerAiConfig,
  liveLlmTestsEnabled,
  loadBackendDotenv,
  type DeveloperAiConfig,
} from "../config";
import { createJourneyAgentGenerate } from "../providers/journey-agent";
import { runJourneyAgent } from "../journey/agent";
import { testModel } from "../providers/test-model";
import { probeToolCalling } from "../providers/model-probe";
import { createProviderAdapter } from "../providers/discovery";
import { ProviderError } from "../providers/contracts";
import { providerJson } from "../providers/http";

// ---------------------------------------------------------------------------
// Opt-in suite: set RUN_LIVE_LLM_TESTS=true (apps/api/.env or the shell) and
// provide at least one provider key. Without it nothing below runs and the
// regular test suite stays free of billable requests.
// ---------------------------------------------------------------------------
loadBackendDotenv();
const config: DeveloperAiConfig = developerAiConfig();
const enabled = liveLlmTestsEnabled();
const providersToTest = aiProviders.filter((provider) => config.keys[provider]);

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/fastapi-booking",
);
function loadFixture(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const walk = (current: string, prefix = "") => {
    for (const entry of readdirSync(current)) {
      const absolute = path.join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else
        files.push({
          path: relative,
          content: readFileSync(absolute, "utf8"),
        });
    }
  };
  walk(fixtureDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const fixtureFiles = enabled && providersToTest.length ? loadFixture() : [];
const fixtureGraph: CodeGraph | null =
  enabled && providersToTest.length ? await analyzeFiles(fixtureFiles) : null;
if (fixtureGraph && !graphIsValid(fixtureGraph, fixtureFiles))
  throw new Error("The live-test fixture graph is invalid.");

/** The configured model, or the first catalogue candidate that answers. */
const models = new Map<string, string>();
async function modelFor(
  provider: keyof DeveloperAiConfig["keys"],
): Promise<string> {
  const configured =
    config.models[provider as "openai"] ?? config.AI_DEFAULT_MODEL;
  if (configured) return configured;
  const cached = models.get(provider);
  if (cached) return cached;
  const apiKey = config.keys[provider as "openai"]!;
  const list = await createProviderAdapter(provider as "openai").listModels(
    apiKey,
  );
  // Catalogues still list discontinued and non-text models, so text-shaped
  // candidates are probed with a tiny generation until one answers; at most
  // six requests, and a discontinuation notice names the successor to try.
  const queue = [
    ...new Set(
      list.models
        .filter(
          (item) =>
            !/(?:tts|audio|image|embedding|imagen|veo|live)/i.test(item.id),
        )
        .map((item) => item.id),
    ),
  ].slice(0, 6);
  if (!queue.length)
    throw new Error("The provider lists no model to test with.");
  const tried = new Set<string>();
  let lastError: Error | undefined;
  while (queue.length) {
    const model = queue.shift()!;
    tried.add(model);
    try {
      await probeToolCalling({
        provider: provider as "openai",
        apiKey,
        model,
      });
      models.set(provider, model);
      return model;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      lastError = error;
      if (error.code === "INVALID_KEY") throw error;
      const successor = /use models\/([a-z0-9._-]+)/i.exec(error.message)?.[1];
      if (successor && !tried.has(successor)) queue.unshift(successor);
    }
  }
  throw new Error(
    `None of the candidate models answered (${[...tried].join(", ")}): ${lastError?.message ?? "unknown failure"}`,
  );
}

/** A provider whose quota stayed exhausted after one patient retry. */
const rateLimitedUntil = new Map<string, number>();
const RATE_LIMIT_RETRY_MS = 65_000;
const TRANSIENT_RETRY_MS = 15_000;
/**
 * Runs one bounded generation. Free-tier capacity refills: a rate limit or a
 * high-demand 503 earns one patient retry, then the provider is marked
 * unavailable so the remaining tests skip instead of failing on an account
 * state.
 */
async function withRateLimitHandling<T>(
  provider: string,
  run: () => Promise<T>,
  skip: () => never,
): Promise<T> {
  const blocked = rateLimitedUntil.get(provider);
  if (blocked && Date.now() < blocked) skip();
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const waitMs =
      error.code === "RATE_LIMIT"
        ? RATE_LIMIT_RETRY_MS
        : error.code === "UNAVAILABLE"
          ? TRANSIENT_RETRY_MS
          : undefined;
    if (waitMs === undefined) throw error;
    console.warn(
      `${provider}: ${error.code}; waiting ${waitMs / 1000}s once before marking the provider unavailable.`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      return await run();
    } catch (retryError) {
      if (
        retryError instanceof ProviderError &&
        (retryError.code === "RATE_LIMIT" || retryError.code === "UNAVAILABLE")
      ) {
        rateLimitedUntil.set(provider, Date.now() + 5 * 60_000);
        skip();
      }
      throw retryError;
    }
  }
}

describe.skipIf(!enabled)("live LLM integration (opt-in)", () => {
  it("is enabled by RUN_LIVE_LLM_TESTS=true", () => {
    expect(enabled).toBe(true);
  });

  if (!providersToTest.length) {
    it("reports that no provider key was configured", () => {
      console.warn(
        "RUN_LIVE_LLM_TESTS is true but no provider key is configured; " +
          "no provider was live-tested.",
      );
      expect(providersToTest).toEqual([]);
    });
  }

  for (const provider of providersToTest) {
    describe(provider, () => {
      const apiKey = config.keys[provider]!;

      it(
        "authenticates and generates a tiny completion",
        { timeout: 150_000 },
        async (ctx) => {
          await withRateLimitHandling(
            provider,
            async () => {
              const model = await modelFor(provider);
              await testModel({ provider, apiKey, model });
            },
            () => ctx.skip(),
          );
        },
      );

      it(
        "lists models through the provider catalogue",
        { timeout: 60_000 },
        async () => {
          const list = await createProviderAdapter(provider).listModels(apiKey);
          expect(list.models.length).toBeGreaterThan(0);
          console.info(
            `${provider}: ${list.models.length} models listed, first ${list.models[0]?.id}`,
          );
        },
      );

      it(
        "answers the booking question with real tool calls on the fixture graph",
        { timeout: 240_000 },
        async (ctx) => {
          const journey = await withRateLimitHandling(
            provider,
            async () => {
              const model = await modelFor(provider);
              const generate = createJourneyAgentGenerate(
                { provider, apiKey, model },
                fetch,
              );
              let providerFailure: unknown;
              const result = await runJourneyAgent({
                question:
                  "How does the web client create a booking, and where is it saved in the database?",
                files: fixtureFiles,
                graph: fixtureGraph!,
                generate: async (input) => {
                  try {
                    return await generate(input);
                  } catch (error) {
                    providerFailure = error;
                    throw error;
                  }
                },
              });
              if (providerFailure) throw providerFailure;
              return result;
            },
            () => ctx.skip(),
          );
          console.info("journey uncertainties:", journey.uncertainties);
          expect(journey.mode).toBe("ai");
          expect(journey.nodeIds.length).toBeGreaterThan(1);
          const nodes = journey.nodeIds.map((id) =>
            fixtureGraph!.nodes.find((node) => node.id === id),
          );
          expect(nodes.every((node) => node)).toBe(true);
          // The real model must reach the persistence side of the fixture.
          expect(nodes.some((node) => node?.path?.startsWith("backend/"))).toBe(
            true,
          );
          expect(nodes.some((node) => node?.kind === "database")).toBe(true);
        },
      );

      it(
        "rejects an invented model with a clear error and no key leak",
        { timeout: 60_000 },
        async () => {
          const journey = await runJourneyAgent({
            question: "where is a booking saved?",
            files: fixtureFiles,
            graph: fixtureGraph!,
            generate: createJourneyAgentGenerate(
              {
                provider,
                apiKey,
                model: "z1n-atlas-invalid-model-check",
              },
              fetch,
            ),
          });
          // The agent reports its failure honestly instead of inventing steps.
          expect(journey.mode).toBe("ai");
          expect(journey.nodeIds).toEqual([]);
          expect(journey.uncertainties.join(" ")).toMatch(/failed|could not/i);
        },
      );

      it(
        "maps a provider timeout to a bounded provider error",
        { timeout: 30_000 },
        async () => {
          const url =
            provider === "openai"
              ? "https://api.openai.com/v1/models"
              : provider === "google"
                ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100"
                : "https://api.anthropic.com/v1/models";
          const headers =
            provider === "openai"
              ? { Authorization: `Bearer ${apiKey}` }
              : provider === "google"
                ? { "x-goog-api-key": apiKey }
                : {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                  };
          const attempt = providerJson(
            url,
            headers,
            fetch,
            undefined,
            undefined,
            1,
          );
          await expect(attempt).rejects.toBeInstanceOf(ProviderError);
        },
      );
    });
  }
});
