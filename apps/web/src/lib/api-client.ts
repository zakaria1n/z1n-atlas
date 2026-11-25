import {
  analysisRequestSchema,
  apiErrorSchema,
  codeGraphSchema,
  githubSnapshotSchema,
  graphIsValid,
  providerRequestSchema,
  modelListSchema,
  providerTestRequestSchema,
  providerTestResultSchema,
  chatRequestSchema,
  chatAnswerSchema,
  journeyRequestSchema,
  journeySchema,
  journeyIsValid,
  analysisJobStartSchema,
  analysisJobSchema,
  githubFileRequestSchema,
  inspectionFileSchema,
  type AnalysisRequest,
  type GitHubRepository,
  type ProviderRequest,
  type ProviderTestRequest,
  type ChatRequest,
  type JourneyRequest,
  type CodeGraph,
  type AnalysisJob,
} from "@z1n/contracts";

const configured = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
export function backendUrl(): string {
  const url = new URL(configured);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "The configured API address must use HTTPS, or HTTP on localhost.",
    );
  return url.origin;
}
export function apiOrigin(): string {
  return backendUrl();
}
export function apiOriginLabel(): string {
  try {
    return apiOrigin();
  } catch {
    return "unavailable (invalid API address)";
  }
}
async function send(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${backendUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsed.success
        ? parsed.data.error
        : "The server could not complete the request.",
    );
  }
  return payload;
}
export async function importPublicRepository(
  repository: GitHubRepository,
  signal?: AbortSignal,
) {
  const parsed = githubSnapshotSchema.safeParse(
    await send("/api/repositories/import", { url: repository.url }, signal),
  );
  if (!parsed.success)
    throw new Error("The server returned an invalid repository response.");
  return parsed.data;
}
export async function readPublicRepositoryFile(
  url: string,
  commit: string,
  path: string,
  signal?: AbortSignal,
) {
  const request = githubFileRequestSchema.parse({ url, commit, path });
  const parsed = inspectionFileSchema.safeParse(
    await send("/api/repositories/file", request, signal),
  );
  if (!parsed.success || parsed.data.path !== path)
    throw new Error("The server returned an invalid source file.");
  return parsed.data;
}
export async function discoverModels(
  input: ProviderRequest,
  signal?: AbortSignal,
) {
  const request = providerRequestSchema.parse(input);
  const parsed = modelListSchema.safeParse(
    await send("/api/providers/models", request, signal),
  );
  if (!parsed.success)
    throw new Error("The server returned an invalid model list.");
  return parsed.data;
}
export async function testProviderModel(
  input: ProviderTestRequest,
  signal?: AbortSignal,
) {
  const request = providerTestRequestSchema.parse(input);
  const parsed = providerTestResultSchema.safeParse(
    await send("/api/providers/test", request, signal),
  );
  if (!parsed.success)
    throw new Error("The server returned an invalid test response.");
  return parsed.data;
}
export async function askRepository(input: ChatRequest, signal?: AbortSignal) {
  const request = chatRequestSchema.parse(input);
  const parsed = chatAnswerSchema.safeParse(
    await send("/api/chat", request, signal),
  );
  if (!parsed.success)
    throw new Error("The server returned an invalid answer.");
  const files = new Map(
    request.files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  for (const claim of parsed.data.claims)
    for (const citation of claim.citations) {
      const lines = files.get(citation.filePath);
      if (
        !lines ||
        citation.endLine < citation.startLine ||
        citation.endLine > lines.length ||
        !citation.snippet ||
        !lines
          .slice(citation.startLine - 1, citation.endLine)
          .join("\n")
          .includes(citation.snippet.replace(/\r\n|\r/g, "\n"))
      )
        throw new Error("The server returned an invalid source citation.");
    }
  return parsed.data;
}
export async function requestJourney(
  input: JourneyRequest,
  graph: CodeGraph,
  signal?: AbortSignal,
) {
  const request = journeyRequestSchema.parse(input);
  const parsed = journeySchema.safeParse(
    await send("/api/journeys", request, signal),
  );
  if (!parsed.success || !journeyIsValid(parsed.data, graph))
    throw new Error("The server returned an invalid journey.");
  return parsed.data;
}
export async function analyzeRepository(
  input: AnalysisRequest,
  signal?: AbortSignal,
  onProgress?: (
    stage: Extract<AnalysisJob, { status: "running" }>["stage"],
  ) => void,
) {
  const request = analysisRequestSchema.parse(input);
  const started = analysisJobStartSchema.safeParse(
    await send("/api/analysis/jobs", request, signal),
  );
  if (!started.success)
    throw new Error("The server returned an invalid analysis job.");
  const url = `${backendUrl()}/api/analysis/jobs/${started.data.jobId}`;
  const release = () => {
    void fetch(url, {
      method: "DELETE",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {});
  };
  if (signal?.aborted) {
    release();
    throw new DOMException("Analysis cancelled.", "AbortError");
  }
  signal?.addEventListener("abort", release, { once: true });
  try {
    while (true) {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success
            ? parsed.data.error
            : "Analysis status is unavailable.",
        );
      }
      const state = analysisJobSchema.safeParse(payload);
      if (!state.success)
        throw new Error("The server returned an invalid analysis status.");
      if (state.data.status === "complete") {
        const graph = codeGraphSchema.parse(state.data.graph);
        if (!graphIsValid(graph, request.files))
          throw new Error("The server returned invalid graph evidence.");
        return graph;
      }
      if (state.data.status === "failed") throw new Error(state.data.error);
      if (state.data.status === "cancelled")
        throw new DOMException("Analysis cancelled.", "AbortError");
      onProgress?.(state.data.stage);
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const timer = setTimeout(finish, 400);
        const cancel = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(new DOMException("Analysis cancelled.", "AbortError"));
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    }
  } finally {
    signal?.removeEventListener("abort", release);
    release();
  }
}
