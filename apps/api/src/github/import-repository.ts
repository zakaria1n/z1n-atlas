import { z } from "zod";
import { isEligiblePath, MAX_SOURCE_FILE_BYTES } from "@z1n/contracts";
import type { GitHubRepository } from "@z1n/contracts";
import { selectRepositoryFiles } from "./selection";

const MAX_TREE_BYTES = 8_000_000;
export type ImportedFile = { path: string; size: number; content: string };
export type GitHubSnapshot = {
  repository: GitHubRepository;
  commit: string;
  files: ImportedFile[];
  skipped: number;
  truncated: boolean;
};
export class GitHubImportError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "RATE_LIMIT" | "TOO_LARGE" | "UPSTREAM",
    message: string,
  ) {
    super(message);
  }
}

const metadataSchema = z.object({
  private: z.boolean(),
  default_branch: z.string().min(1).max(255),
});
const commitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) });
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      mode: z.string(),
      size: z.number().int().nonnegative().optional(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/i)
        .optional(),
    }),
  ),
});
async function readResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.ok) {
    if (response.status === 404)
      throw new GitHubImportError(
        "NOT_FOUND",
        "Repository or revision not found. Check that it is public.",
      );
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    )
      throw new GitHubImportError(
        "RATE_LIMIT",
        "GitHub's rate limit was reached. Try again later.",
      );
    throw new GitHubImportError(
      "UPSTREAM",
      "GitHub could not complete the request. Try again later.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new GitHubImportError(
      "UPSTREAM",
      "GitHub returned an empty response.",
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new GitHubImportError(
        "TOO_LARGE",
        "GitHub's response exceeded the import limit.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function getJson(
  path: string,
  maxBytes: number,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const bytes = await readResponse(response, maxBytes, signal);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GitHubImportError(
      "UPSTREAM",
      "GitHub returned an invalid response.",
    );
  }
}
async function getRaw(
  repository: GitHubRepository,
  commit: string,
  path: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const parts = [
    repository.owner,
    repository.name,
    commit,
    ...path.split("/"),
  ].map(encodeURIComponent);
  const response = await fetcher(
    `https://raw.githubusercontent.com/${parts.join("/")}`,
    {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    },
  );
  return readResponse(response, MAX_SOURCE_FILE_BYTES, signal);
}

export async function importGitHubRepository(
  repository: GitHubRepository,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<GitHubSnapshot> {
  const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const deadline = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const metadata = metadataSchema.parse(
      await getJson(base, 100_000, fetcher, combined),
    );
    if (metadata.private)
      throw new GitHubImportError(
        "NOT_FOUND",
        "Only public repositories are supported.",
      );
    const commit = commitSchema.parse(
      await getJson(
        `${base}/commits/${encodeURIComponent(metadata.default_branch)}`,
        1_000_000,
        fetcher,
        combined,
      ),
    ).sha;
    const tree = treeSchema.parse(
      await getJson(
        `${base}/git/trees/${commit}?recursive=1`,
        MAX_TREE_BYTES,
        fetcher,
        combined,
      ),
    );
    const candidates = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        entry.sha &&
        entry.size !== undefined &&
        entry.size <= MAX_SOURCE_FILE_BYTES &&
        isEligiblePath(entry.path),
    );
    let skipped =
      tree.tree.filter((entry) => entry.type === "blob").length -
      candidates.length;
    const selected = selectRepositoryFiles(
      candidates.map((entry) => ({ ...entry, size: entry.size! })),
    );
    skipped += candidates.length - selected.length;
    const files: ImportedFile[] = [];
    for (let index = 0; index < selected.length; index += 8) {
      combined.throwIfAborted();
      const batch = selected.slice(index, index + 8);
      const results = await Promise.all(
        batch.map(async (entry) => {
          const bytes = await getRaw(
            repository,
            commit,
            entry.path,
            fetcher,
            combined,
          );
          if (bytes.length !== entry.size || bytes.includes(0)) return null;
          try {
            return {
              path: entry.path,
              size: bytes.length,
              content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            };
          } catch {
            return null;
          }
        }),
      );
      for (const item of results) {
        if (item) files.push(item);
        else skipped++;
      }
    }
    return { repository, commit, files, skipped, truncated: tree.truncated };
  } catch (error) {
    if (error instanceof GitHubImportError) throw error;
    throw new GitHubImportError(
      "UPSTREAM",
      "GitHub returned an unexpected response or the request timed out.",
    );
  }
}
