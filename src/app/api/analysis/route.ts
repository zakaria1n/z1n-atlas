import { z } from "zod";
import { isEligiblePath } from "@/core/repository/file-filter";
import { AnalysisError, runAnalysis } from "@/server/analyzer/run-analysis";

const fileSchema = z
  .object({
    path: z.string().min(1).max(500),
    content: z.string().max(100_000),
  })
  .strict();
const inputSchema = z.object({ files: z.array(fileSchema).max(25) }).strict();
const attempts: number[] = [];
let active = 0;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const fail = (message: string, status: number) =>
    Response.json({ error: message }, { status, headers });
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return fail("Invalid request origin or content type.", 403);
  const reader = request.body?.getReader();
  if (!reader) return fail("Source files are required.", 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2_000_000) {
      await reader.cancel();
      return fail("Source selection is too large.", 413);
    }
    chunks.push(value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("Invalid request.", 400);
  }
  const result = inputSchema.safeParse(body);
  if (!result.success) return fail("Invalid source selection.", 400);
  const files = result.data.files;
  const paths = new Set(files.map((file) => file.path));
  if (
    paths.size !== files.length ||
    files.some(
      (file) =>
        !isEligiblePath(file.path) ||
        Buffer.byteLength(file.content, "utf8") > 100_000,
    ) ||
    files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
      0,
    ) > 1_000_000
  )
    return fail(
      "Source selection contains invalid paths or exceeds the limits.",
      400,
    );
  const now = Date.now();
  while (attempts.length && attempts[0] <= now - 60_000) attempts.shift();
  if (active >= 2 || attempts.length >= 5)
    return fail("Analysis is busy. Try again shortly.", 429);
  active++;
  attempts.push(now);
  try {
    const graph = await runAnalysis(files);
    return Response.json(graph, { headers });
  } catch (error) {
    return fail(
      error instanceof AnalysisError ? error.message : "Analysis failed.",
      500,
    );
  } finally {
    active--;
  }
}
