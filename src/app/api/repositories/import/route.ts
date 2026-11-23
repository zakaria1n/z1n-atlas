import { z } from "zod";
import { parseGitHubRepository } from "@/core/repository/github-url";
import {
  GitHubImportError,
  importGitHubRepository,
} from "@/server/github/import-repository";

const inputSchema = z.object({ url: z.string().max(500) }).strict();
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
  if (!reader) return fail("A repository URL is required.", 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2048) {
      await reader.cancel();
      return fail("Request is too large.", 413);
    }
    chunks.push(value);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("Enter a valid repository URL.", 400);
  }
  const parsed = inputSchema.safeParse(input);
  const repository = parsed.success
    ? parseGitHubRepository(parsed.data.url)
    : null;
  if (!repository)
    return fail(
      "Enter a public GitHub repository URL, such as https://github.com/owner/repository.",
      400,
    );
  const now = Date.now();
  while (attempts.length && attempts[0] <= now - 60_000) attempts.shift();
  if (active >= 2 || attempts.length >= 5)
    return fail("Import is busy. Please try again shortly.", 429);
  attempts.push(now);
  active++;
  try {
    const snapshot = await importGitHubRepository(repository);
    return Response.json(snapshot, { headers });
  } catch (error) {
    if (error instanceof GitHubImportError)
      return fail(
        error.message,
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "RATE_LIMIT"
            ? 429
            : error.code === "TOO_LARGE"
              ? 413
              : 502,
      );
    return fail("Import failed. Please try again.", 502);
  } finally {
    active--;
  }
}
