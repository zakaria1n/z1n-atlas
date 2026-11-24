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
  type AnalysisRequest,
  type GitHubRepository,
  type ProviderRequest,
  type ProviderTestRequest,
} from "@z1n/contracts";

const configured = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
function backendUrl(): string {
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
export async function importPublicRepository(repository: GitHubRepository) {
  const parsed = githubSnapshotSchema.safeParse(
    await send("/api/repositories/import", { url: repository.url }),
  );
  if (!parsed.success)
    throw new Error("The server returned an invalid repository response.");
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
export async function analyzeRepository(
  input: AnalysisRequest,
  signal?: AbortSignal,
) {
  const request = analysisRequestSchema.parse(input);
  const parsed = codeGraphSchema.safeParse(
    await send("/api/analysis", request, signal),
  );
  if (!parsed.success || !graphIsValid(parsed.data, request.files))
    throw new Error("The server returned invalid graph evidence.");
  return parsed.data;
}
