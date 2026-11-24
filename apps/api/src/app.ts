import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  analysisRequestSchema,
  apiErrorSchema,
  codeGraphSchema,
  githubSnapshotSchema,
  parseGitHubRepository,
  repositoryUrlRequestSchema,
  providerRequestSchema,
  modelListSchema,
  providerTestRequestSchema,
  providerTestResultSchema,
  chatRequestSchema,
  chatAnswerSchema,
  journeyRequestSchema,
  journeySchema,
  graphIsValid,
} from "@z1n/contracts";
import {
  importGitHubRepository,
  GitHubImportError,
} from "./github/import-repository";
import { createProviderAdapter } from "./providers/discovery";
import { ProviderError } from "./providers/contracts";
import { testModel } from "./providers/test-model";
import { generateAnswer } from "./providers/generate-answer";
import { answerQuestion } from "./evidence/answer";
import { findJourney } from "./journey/find-journey";
import { runAnalysis, AnalysisError } from "./analyzer/run-analysis";

export async function createApp(
  webOrigin = "http://localhost:3000",
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2_000_000,
    requestTimeout: 45_000,
  });
  await app.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type"],
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== webOrigin)
      return reply
        .code(403)
        .send(apiErrorSchema.parse({ error: "Invalid request origin." }));
  });
  let active = 0;
  const attempts: number[] = [];
  function canStart(): boolean {
    const now = Date.now();
    while (attempts.length && attempts[0] <= now - 60_000) attempts.shift();
    if (active >= 2 || attempts.length >= 5) return false;
    attempts.push(now);
    active++;
    return true;
  }
  app.get("/health", async () => ({ status: "ok" }));
  app.post(
    "/api/repositories/import",
    { bodyLimit: 2048 },
    async (request, reply) => {
      const input = repositoryUrlRequestSchema.safeParse(request.body);
      const repository = input.success
        ? parseGitHubRepository(input.data.url)
        : null;
      if (!repository)
        return reply
          .code(400)
          .send({ error: "Enter a public GitHub repository URL." });
      if (!canStart())
        return reply
          .code(429)
          .send({ error: "Service is busy. Try again shortly." });
      const abort = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", cancel);
      try {
        return githubSnapshotSchema.parse(
          await importGitHubRepository(repository, fetch, abort.signal),
        );
      } catch (error) {
        if (error instanceof GitHubImportError)
          return reply
            .code(
              error.code === "NOT_FOUND"
                ? 404
                : error.code === "RATE_LIMIT"
                  ? 429
                  : error.code === "TOO_LARGE"
                    ? 413
                    : 502,
            )
            .send({ error: error.message });
        return reply.code(502).send({ error: "Import failed. Try again." });
      } finally {
        reply.raw.off("close", cancel);
        active--;
      }
    },
  );
  app.post("/api/analysis", async (request, reply) => {
    const input = analysisRequestSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "Invalid source selection or missing consent." });
    if (!canStart())
      return reply
        .code(429)
        .send({ error: "Service is busy. Try again shortly." });
    const abort = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once("close", cancel);
    try {
      const graph = await runAnalysis(input.data.files, 15_000, abort.signal);
      return codeGraphSchema.parse(graph);
    } catch (error) {
      return reply.code(500).send({
        error:
          error instanceof AnalysisError ? error.message : "Analysis failed.",
      });
    } finally {
      reply.raw.off("close", cancel);
      active--;
    }
  });
  app.post(
    "/api/providers/models",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const input = providerRequestSchema.safeParse(request.body);
      if (!input.success)
        return reply
          .code(400)
          .send({ error: "Choose a provider and enter a valid API key." });
      if (!canStart())
        return reply
          .code(429)
          .send({ error: "Service is busy. Try again shortly." });
      const abort = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", cancel);
      try {
        const result = await createProviderAdapter(
          input.data.provider,
        ).listModels(input.data.apiKey, abort.signal);
        return modelListSchema.parse(result);
      } catch (error) {
        if (error instanceof ProviderError) {
          const status =
            error.code === "INVALID_KEY"
              ? 401
              : error.code === "FORBIDDEN"
                ? 403
                : error.code === "RATE_LIMIT"
                  ? 429
                  : 502;
          return reply.code(status).send({ error: error.message });
        }
        return reply
          .code(502)
          .send({ error: "The provider could not complete the request." });
      } finally {
        reply.raw.off("close", cancel);
        active--;
      }
    },
  );
  app.post(
    "/api/providers/test",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const input = providerTestRequestSchema.safeParse(request.body);
      if (!input.success)
        return reply
          .code(400)
          .send({ error: "Choose a provider, key and valid model." });
      if (!canStart())
        return reply
          .code(429)
          .send({ error: "Service is busy. Try again shortly." });
      const abort = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", cancel);
      try {
        await testModel(input.data, abort.signal);
        return providerTestResultSchema.parse({ ok: true });
      } catch (error) {
        if (error instanceof ProviderError) {
          const status =
            error.code === "INVALID_KEY"
              ? 401
              : error.code === "FORBIDDEN"
                ? 403
                : error.code === "RATE_LIMIT"
                  ? 429
                  : 502;
          return reply.code(status).send({ error: error.message });
        }
        return reply
          .code(502)
          .send({ error: "The provider could not complete the request." });
      } finally {
        reply.raw.off("close", cancel);
        active--;
      }
    },
  );
  app.post("/api/chat", async (request, reply) => {
    const input = chatRequestSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "Invalid request or missing source-sharing consent." });
    if (!canStart())
      return reply
        .code(429)
        .send({ error: "Service is busy. Try again shortly." });
    const abort = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once("close", cancel);
    try {
      const graph = await runAnalysis(input.data.files, 15_000, abort.signal);
      const { provider, apiKey, model, question, files } = input.data;
      const answer = await answerQuestion(question, files, graph, (context) =>
        generateAnswer({ provider, apiKey, model }, context, abort.signal),
      );
      return chatAnswerSchema.parse(answer);
    } catch (error) {
      if (error instanceof ProviderError) {
        const status =
          error.code === "INVALID_KEY"
            ? 401
            : error.code === "FORBIDDEN"
              ? 403
              : error.code === "RATE_LIMIT"
                ? 429
                : 502;
        return reply.code(status).send({ error: error.message });
      }
      return reply
        .code(502)
        .send({ error: "The answer could not be generated. Try again." });
    } finally {
      reply.raw.off("close", cancel);
      active--;
    }
  });
  app.post("/api/journeys", async (request, reply) => {
    const input = journeyRequestSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "Invalid request or missing source-sharing consent." });
    if (!canStart())
      return reply
        .code(429)
        .send({ error: "Service is busy. Try again shortly." });
    const abort = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once("close", cancel);
    try {
      const graph = codeGraphSchema.parse(
        await runAnalysis(input.data.files, 15_000, abort.signal),
      );
      if (!graphIsValid(graph, input.data.files))
        throw new Error("Invalid graph.");
      return journeySchema.parse(findJourney(input.data.goal, graph));
    } catch {
      return reply
        .code(500)
        .send({ error: "The journey could not be computed. Try again." });
    } finally {
      reply.raw.off("close", cancel);
      active--;
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      error && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status =
      typeof candidate === "number" && candidate >= 400 && candidate < 500
        ? candidate
        : 500;
    reply.code(status).send({
      error:
        status === 413
          ? "Request is too large."
          : status === 400
            ? "Invalid request."
            : "The service could not complete the request.",
    });
  });
  return app;
}
