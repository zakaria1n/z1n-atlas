"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRepositorySession, type SourceFile } from "./repository-session";
import { parseGitHubRepository } from "@z1n/contracts";
import { importPublicRepository } from "@/lib/api-client";

type Summary = {
  repository: { url: string };
  commit: string;
  files: SourceFile[];
  skipped: number;
  truncated: boolean;
};
export function GitHubImport() {
  const { setSession } = useRepositorySession();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSummary(null);
    const repository = parseGitHubRepository(url);
    if (!repository) {
      setError(
        "Enter a public GitHub repository URL, such as https://github.com/owner/repository.",
      );
      return;
    }
    setBusy(true);
    try {
      const snapshot = await importPublicRepository(repository);
      setSummary(snapshot);
      setSession({
        label: snapshot.repository.url,
        origin: "github",
        files: snapshot.files,
        skipped: snapshot.skipped,
        truncated: snapshot.truncated,
        commit: snapshot.commit,
      });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not reach the server. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="option">
      <div className="option-icon" aria-hidden="true">
        ↗
      </div>
      <h2>Public GitHub repository</h2>
      <p>
        Read eligible source files from a public repository default branch. Up
        to 25 files, 100 KB per file and 1 MB total; sensitive paths and
        generated files are excluded.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="github-url">GitHub repository URL</label>
        <input
          id="github-url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/owner/repository"
          required
          disabled={busy}
          aria-describedby={error ? "import-error" : undefined}
        />
        <button type="submit" className="import-button" disabled={busy}>
          {busy ? "Reading repository…" : "Import repository"}
        </button>
      </form>
      <p aria-live="polite">
        {busy &&
          "Reading repository metadata and eligible files from GitHub. This may take a moment."}
      </p>
      {error && (
        <p id="import-error" role="alert" className="error">
          {error}
        </p>
      )}
      {summary && (
        <div className="result" role="status">
          <h3>Repository read</h3>
          <p>{summary.repository.url}</p>
          <p>
            {summary.files.length} files read · {summary.skipped} files skipped
          </p>
          <p>
            Commit: <code>{summary.commit.slice(0, 12)}</code>
          </p>
          {summary.truncated && (
            <p>
              GitHub returned a truncated file tree; coverage is incomplete.
            </p>
          )}
          <p>Source is held in memory until reload or tab closure.</p>
          <Link className="text-link" href="/workspace">
            Browse imported files →
          </Link>
        </div>
      )}
    </section>
  );
}
