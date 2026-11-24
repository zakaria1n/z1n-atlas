import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  analysisRequestSchema,
  apiErrorSchema,
  codeGraphSchema,
  githubSnapshotSchema,
  parseGitHubRepository,
  repositoryUrlRequestSchema,
} from "@z1n/contracts";
import {
  importGitHubRepository,
  GitHubImportError,
} from "./github/import-repository";
import { runAnalysis, AnalysisError } from "./analyzer/run-analysis";

export async function createApp(
  webOrigin = "http://localhost:3000",
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2_000_000,
    requestTimeout: 20_000,
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
      try {
        return githubSnapshotSchema.parse(
          await importGitHubRepository(repository),
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
