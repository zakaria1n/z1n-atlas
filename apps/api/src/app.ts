import Fastify, { type FastifyInstance } from "fastify";
import type { Provider } from "@z1n/contracts";
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
import { probeToolCalling } from "./providers/model-probe";
import { answerWithGraph } from "./orchestration/chat-graph";
import { createChatModel } from "./orchestration/chat-model";
import { DevBridgeChatModel } from "./orchestration/dev-bridge-model";
import { runJourneyAgent } from "./orchestration/journey-graph";
import { findJourney } from "./journey/find-journey";
import { runAnalysis, AnalysisError } from "./analyzer/run-analysis";
import { createAnalysisCache } from "./analyzer/analysis-cache";
import { createSnapshotCache } from "./analyzer/snapshot-cache";
import { createAnalysisJobs } from "./analyzer/analysis-jobs";
import { MAX_GRAPH_BYTES } from "./analyzer/limits";
import {
  semanticRetrievalEnabled,
  serverAiCredential,
  type ServerAiCredential,
} from "./config";
import {
  externalDevAgentEnabled,
  externalDevAgentGenerate,
} from "./providers/external-dev-agent";
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

/**
 * The credential a request is served with: the user's own key (BYOK, never
 * stored) or, when the request opted in and this development server enabled
 * it, the backend environment. Null selects static behaviour.
 */
class ServerAiUnavailable extends Error {}
function resolveAiCredential(
  request:
    | {
        ai?: {
          provider: "openai" | "google" | "anthropic";
          apiKey: string;
          model: string;
        };
        serverAi?: boolean;
        history?: unknown[];
      }
    | undefined,
): {
  credential: {
    provider: Provider;
    apiKey: string;
    model: string | null;
  } | null;
  serverManaged: boolean;
} {
  if (request?.ai)
    return {
      credential: {
        provider: request.ai.provider,
        apiKey: request.ai.apiKey,
        model: request.ai.model,
      },
      serverManaged: false,
    };
  if (request?.serverAi) {
    const credential = serverAiCredential();
    if (!credential)
      throw new ServerAiUnavailable(
        "Server-managed AI is not enabled on this server. Configure apps/api/.env with ENABLE_DEV_LLM_KEYS=true and a provider key, outside production.",
      );
    return { credential, serverManaged: true };
  }
  return { credential: null, serverManaged: false };
}
/**
 * A configured backend credential without a model discovers one from the
 * provider. The first advertised model wins; results are cached briefly so
 * repeated questions do not re-list the catalogue.
 */
const discoveredModels = new Map<string, { model: string; expires: number }>();
const DISCOVERY_TTL_MS = 10 * 60_000;
async function modelFor(credential: ServerAiCredential): Promise<string> {
  if (credential.model) return credential.model;
  const cacheKey = `${credential.provider}:${credential.apiKey.length}`;
  const cached = discoveredModels.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.model;
  const list = await createProviderAdapter(credential.provider).listModels(
    credential.apiKey,
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
  const tried = new Set<string>();
  let lastError: ProviderError | undefined;
  while (queue.length) {
    const model = queue.shift()!;
    tried.add(model);
    try {
      // The journey needs tool calling, not just text generation, so the
      // probe mirrors that requirement.
      await probeToolCalling({
        provider: credential.provider,
        apiKey: credential.apiKey,
        model,
      });
      discoveredModels.set(cacheKey, {
        model,
        expires: Date.now() + DISCOVERY_TTL_MS,
      });
      return model;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      lastError = error;
      // Only a rejected key says something about every candidate; missing
      // models, per-model quotas, per-model tool permissions and load are
      // all worth trying the next candidate against.
      if (error.code === "INVALID_KEY") throw error;
      const successor = /use models\/([a-z0-9._-]+)/i.exec(
        error.providerDetail ?? error.message,
      )?.[1];
      if (successor && !tried.has(successor)) queue.unshift(successor);
    }
  }
  throw (
    lastError ??
    new ProviderError(
      "INVALID_RESPONSE",
      "The provider lists no usable model. Configure AI_DEFAULT_MODEL in apps/api/.env.",
    )
  );
}
/** A server-managed credential completed with its discovered model. */
async function withDiscoveredModel(credential: ServerAiCredential): Promise<{
  provider: Provider;
  apiKey: string;
  model: string;
}> {
  return {
    provider: credential.provider,
    apiKey: credential.apiKey,
    model: await modelFor(credential),
  };
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
  const snapshots = createSnapshotCache();
  const analysisJobs = createAnalysisJobs();
  app.addHook("onClose", async () => {
    analysisJobs.clear();
    analysisCache.clear();
    snapshots.clear();
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
  // Tells the frontend whether server-managed AI exists, without ever
  // exposing the credential itself. Only a development server can answer yes.
  app.get("/api/ai/status", async () => {
    if (externalDevAgentEnabled())
      return {
        available: true as const,
        provider: "dev-bridge",
        ...(process.env.DEV_AGENT_BRIDGE_MODEL
          ? { model: process.env.DEV_AGENT_BRIDGE_MODEL }
          : {}),
      };
    const credential = serverAiCredential();
    if (!credential) return { available: false as const };
    return {
      available: true as const,
      provider: credential.provider,
      ...(credential.model ? { model: credential.model } : {}),
    };
  });
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
    let resolved;
    try {
      resolved = resolveAiCredential(input.data);
      if (resolved.serverManaged && resolved.credential) {
        const completed = await withDiscoveredModel(resolved.credential);
        resolved.credential.model = completed.model;
        process.stdout.write(
          `AI chat served with ${completed.provider}/${completed.model} from the backend environment.\n`,
        );
      }
    } catch (error) {
      reply.raw.off("close", cancel);
      active--;
      if (error instanceof ProviderError)
        return reply.code(502).send({ error: error.message });
      return reply.code(403).send({
        error:
          error instanceof Error
            ? error.message
            : "Server-managed AI is unavailable.",
      });
    }
    // Development-only chat transport through the same external model
    // bridge the journey uses, presented as a regular chat model. Every
    // step after the slot was taken stays inside the guarded block so a
    // failure always releases the concurrency slot.
    try {
      const { question, files } = input.data;
      const credential = resolved.credential!;
      const model =
        input.data.serverAi && externalDevAgentEnabled()
          ? new DevBridgeChatModel(await externalDevAgentGenerate())
          : createChatModel({
              provider: credential.provider,
              apiKey: credential.apiKey,
              model: credential.model as string,
              maxOutputTokens: 1500,
            });
      const graph =
        analysisCache.get(input.data.analysisId, files) ??
        validatedGraph(
          await runAnalysis(files, { signal: abort.signal }),
          files,
        );
      const snapshot = snapshots.obtain(files, graph);
      // The first eligible request must not stall on a twenty-second
      // embedding build: wait a bounded moment, then answer lexically
      // while the build continues for later requests.
      let semantic:
        import("./evidence/semantic-index").SemanticIndex | undefined;
      let semanticBuildState:
        "idle" | "building" | "ready" | "unavailable" | undefined;
      if (semanticRetrievalEnabled()) {
        const result = await Promise.race([
          snapshot.ensureSemantic(),
          new Promise<"timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), 15_000);
            timer.unref();
          }),
        ]);
        if (result === "timeout") semanticBuildState = snapshot.semanticState();
        else semantic = result;
      }
      const answer = await answerWithGraph({
        question,
        files,
        graph,
        model,
        history: input.data.history ?? [],
        semantic,
        semanticBuildState,
        // Repository-scoped indexes and context are built once per
        // snapshot and reused across requests for the same selection.
        lexical: snapshot.lexical,
        context: snapshot.context,
        signal: abort.signal,
      });
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
      // Repository-scoped snapshot: indexes and context are built once per
      // selection and reused across chat and journey requests.
      const snapshot = snapshots.obtain(input.data.files, graph);
      let semantic:
        import("./evidence/semantic-index").SemanticIndex | undefined;
      if (semanticRetrievalEnabled()) {
        const result = await Promise.race([
          snapshot.ensureSemantic(),
          new Promise<"timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), 15_000);
            timer.unref();
          }),
        ]);
        if (result !== "timeout") semantic = result;
      }
      const resolved = resolveAiCredential(input.data);
      // Development-only external model bridge: the same runJourneyAgent
      // graph, tools and validation run unchanged; only the model transport
      // comes from the external dev module. Never active in production.
      if (
        input.data.serverAi &&
        resolved.serverManaged &&
        externalDevAgentEnabled()
      ) {
        process.stdout.write(
          "AI journey served through the development agent bridge.\n",
        );
        const journey = await runJourneyAgent({
          question: input.data.goal,
          files: input.data.files,
          graph,
          model: new DevBridgeChatModel(await externalDevAgentGenerate()),
          context: snapshot.context,
          semantic,
          signal: abort.signal,
          maxRounds: Number(process.env.Z1N_JOURNEY_MAX_ROUNDS ?? 6),
          maxToolCalls: Number(process.env.Z1N_JOURNEY_MAX_TOOL_CALLS ?? 18),
        });
        return journeySchema.parse(journey);
      }
      if (resolved.credential) {
        // AI-guided mode: the model explores with controlled tools and every
        // identifier it cites is validated against the graph.
        const credential = resolved.serverManaged
          ? await withDiscoveredModel(resolved.credential)
          : {
              provider: resolved.credential.provider,
              apiKey: resolved.credential.apiKey,
              model: resolved.credential.model as string,
            };
        if (resolved.serverManaged)
          process.stdout.write(
            `AI journey served with ${credential.provider}/${credential.model} from the backend environment.\n`,
          );
        const journey = await runJourneyAgent({
          question: input.data.goal,
          files: input.data.files,
          graph,
          model: createChatModel({ ...credential, maxOutputTokens: 1600 }),
          context: snapshot.context,
          semantic,
          signal: abort.signal,
          maxRounds: Number(process.env.Z1N_JOURNEY_MAX_ROUNDS ?? 6),
          maxToolCalls: Number(process.env.Z1N_JOURNEY_MAX_TOOL_CALLS ?? 18),
        });
        return journeySchema.parse(journey);
      }
      // Static mode: deterministic name-based exploration without a provider.
      return journeySchema.parse(findJourney(input.data.goal, graph));
    } catch (error) {
      if (error instanceof ServerAiUnavailable)
        return reply.code(403).send({ error: error.message });
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
