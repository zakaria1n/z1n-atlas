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
  analysisJobStartSchema,
  analysisJobSchema,
  githubFileRequestSchema,
  inspectionFileSchema,
} from "@z1n/contracts";
import {
  importGitHubRepository,
  importErrorStatus,
  GitHubImportError,
  readGitHubFile,
} from "./github/import-repository";
import { createProviderAdapter } from "./providers/discovery";
import { ProviderError } from "./providers/contracts";
import { testModel } from "./providers/test-model";
import { generateAnswer } from "./providers/generate-answer";
import { answerQuestion } from "./evidence/answer";
import { findJourney } from "./journey/find-journey";
import { runJourneyAgent } from "./journey/agent";
import { createJourneyAgentGenerate } from "./providers/journey-agent";
import { runAnalysis, AnalysisError } from "./analyzer/run-analysis";
import { createAnalysisCache } from "./analyzer/analysis-cache";
import { createAnalysisJobs } from "./analyzer/analysis-jobs";
import { MAX_GRAPH_BYTES } from "./analyzer/limits";
function validatedGraph(
  value: unknown,
  files: { path: string; content: string }[],
) {
  const graph = codeGraphSchema.parse(value);
  if (!graphIsValid(graph, files))
    throw new AnalysisError("Analysis returned invalid evidence.");
  if (Buffer.byteLength(JSON.stringify(graph)) > MAX_GRAPH_BYTES)
    throw new AnalysisError("The graph exceeded the result size limit.");
  return graph;
}

export async function createApp(
  webOrigin = "http://localhost:3000",
): Promise<FastifyInstance> {
  // Large enough for the largest permitted source selection as JSON.
  const app = Fastify({
    logger: false,
    bodyLimit: 32_000_000,
    requestTimeout: 45_000,
  });
  const analysisCache = createAnalysisCache();
  const analysisJobs = createAnalysisJobs();
  app.addHook("onClose", async () => {
    analysisJobs.clear();
    analysisCache.clear();
  });
  await app.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["content-type"],
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      (request.method === "POST" ||
        request.method === "DELETE" ||
        (request.method === "GET" &&
          request.url.startsWith("/api/analysis/jobs/"))) &&
      request.headers.origin !== webOrigin
    )
      return reply
        .code(403)
        .send(apiErrorSchema.parse({ error: "Invalid request origin." }));
  });
  let active = 0;
  const attempts: number[] = [];
  let activeInspections = 0;
  const inspectionAttempts: number[] = [];
  function canInspect(): boolean {
    const now = Date.now();
    while (inspectionAttempts.length && inspectionAttempts[0] <= now - 60_000)
      inspectionAttempts.shift();
    if (activeInspections >= 4 || inspectionAttempts.length >= 60) return false;
    inspectionAttempts.push(now);
    activeInspections++;
    return true;
  }
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
    "/api/repositories/file",
    { bodyLimit: 2048 },
    async (request, reply) => {
      const input = githubFileRequestSchema.safeParse(request.body);
      const repository = input.success
        ? parseGitHubRepository(input.data.url)
        : null;
      if (!input.success || !repository)
        return reply
          .code(400)
          .send({ error: "Invalid public repository file request." });
      if (!canInspect())
        return reply
          .code(429)
          .send({ error: "Too many file requests. Try again shortly." });
      const abort = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", cancel);
      try {
        return inspectionFileSchema.parse(
          await readGitHubFile(
            repository,
            input.data.commit,
            input.data.path,
            fetch,
            abort.signal,
          ),
        );
      } catch (error) {
        if (error instanceof GitHubImportError)
          return reply
            .code(importErrorStatus(error.code))
            .send({ error: error.message });
        return reply.code(502).send({ error: "Could not retrieve the file." });
      } finally {
        reply.raw.off("close", cancel);
        activeInspections--;
      }
    },
  );
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
            .code(importErrorStatus(error.code))
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
      const graph = validatedGraph(
        await runAnalysis(input.data.files, { signal: abort.signal }),
        input.data.files,
      );
      const analysisId = analysisCache.put(input.data.files, graph);
      return { ...graph, analysisId };
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
  app.post("/api/analysis/jobs", async (request, reply) => {
    const input = analysisRequestSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({ error: "Invalid source selection or missing consent." });
    if (!canStart())
      return reply
        .code(429)
        .send({ error: "Service is busy. Try again shortly." });
    const id = analysisJobs.start(
      async (signal, progress) => {
        const graph = validatedGraph(
          await runAnalysis(input.data.files, { signal, onProgress: progress }),
          input.data.files,
        );
        const analysisId = analysisCache.put(input.data.files, graph);
        return { ...graph, analysisId };
      },
      () => {
        active--;
      },
    );
    if (!id) {
      active--;
      return reply
        .code(429)
        .send({ error: "Too many analysis jobs. Try again shortly." });
    }
    return reply.code(202).send(analysisJobStartSchema.parse({ jobId: id }));
  });
  app.get("/api/analysis/jobs/:jobId", async (request, reply) => {
    const params = analysisJobStartSchema.safeParse(request.params);
    const state = params.success
      ? analysisJobs.get(params.data.jobId)
      : undefined;
    if (!state)
      return reply
        .code(404)
        .send({ error: "Analysis job was not found or expired." });
    return analysisJobSchema.parse(state);
  });
  app.delete("/api/analysis/jobs/:jobId", async (request, reply) => {
    const params = analysisJobStartSchema.safeParse(request.params);
    if (!params.success || !analysisJobs.cancel(params.data.jobId))
      return reply
        .code(404)
        .send({ error: "Analysis job was not found or expired." });
    return reply.code(204).send();
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
      const { provider, apiKey, model, question, files } = input.data;
      const graph =
        analysisCache.get(input.data.analysisId, files) ??
        validatedGraph(
          await runAnalysis(files, { signal: abort.signal }),
          files,
        );
      const answer = await answerQuestion(question, files, graph, (context) =>
        generateAnswer({ provider, apiKey, model }, context, abort.signal),
      );
      return chatAnswerSchema.parse(answer);
    } catch (error) {
      if (error instanceof AnalysisError)
        return reply.code(500).send({ error: error.message });
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
      const graph =
        analysisCache.get(input.data.analysisId, input.data.files) ??
        validatedGraph(
          await runAnalysis(input.data.files, { signal: abort.signal }),
          input.data.files,
        );
      if (input.data.ai) {
        // AI-guided mode: the model explores with controlled tools and every
        // identifier it cites is validated against the graph.
        const { provider, apiKey, model } = input.data.ai;
        const journey = await runJourneyAgent({
          question: input.data.goal,
          files: input.data.files,
          graph,
          generate: createJourneyAgentGenerate(
            { provider, apiKey, model },
            fetch,
          ),
          signal: abort.signal,
        });
        return journeySchema.parse(journey);
      }
      // Static mode: deterministic name-based exploration without a provider.
      return journeySchema.parse(findJourney(input.data.goal, graph));
    } catch (error) {
      if (error instanceof AnalysisError)
        return reply.code(500).send({ error: error.message });
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
