import { z } from "zod";
import { isEligiblePath } from "@/core/repository/file-filter";
import type { GitHubRepository } from "@/core/repository/github-url";

const MAX_FILES = 25;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 1_000_000;
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
const blobSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative(),
});

async function getJson(
  path: string,
  maxBytes: number,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GitHubImportError(
      "UPSTREAM",
      "GitHub returned an invalid response.",
    );
  }
}

export async function importGitHubRepository(
  repository: GitHubRepository,
  fetcher: typeof fetch = fetch,
): Promise<GitHubSnapshot> {
  const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  try {
    const metadata = metadataSchema.parse(
      await getJson(base, 100_000, fetcher),
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
      ),
    ).sha;
    const tree = treeSchema.parse(
      await getJson(
        `${base}/git/trees/${commit}?recursive=1`,
        MAX_TREE_BYTES,
        fetcher,
      ),
    );
    const candidates = tree.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        entry.sha &&
        entry.size !== undefined &&
        entry.size <= MAX_FILE_BYTES &&
        isEligiblePath(entry.path),
    );
    let skipped =
      tree.tree.filter((entry) => entry.type === "blob").length -
      candidates.length;
    let total = 0;
    const files: ImportedFile[] = [];
    for (const entry of candidates) {
      if (files.length >= MAX_FILES || total + entry.size! > MAX_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      const blob = blobSchema.parse(
        await getJson(
          `${base}/git/blobs/${entry.sha}`,
          MAX_FILE_BYTES * 2 + 10000,
          fetcher,
        ),
      );
      const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      if (
        bytes.length !== blob.size ||
        bytes.length !== entry.size ||
        bytes.includes(0)
      ) {
        skipped++;
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skipped++;
        continue;
      }
      total += bytes.length;
      files.push({ path: entry.path, size: bytes.length, content });
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
