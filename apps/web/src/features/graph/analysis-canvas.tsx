"use client";
import { useEffect, useRef, useState } from "react";
import type { AnalysisJob, CodeGraph } from "@z1n/contracts";
import {
  useRepositorySession,
  type RepositorySession,
} from "@/features/repository-import/repository-session";
import { analyzeRepository, apiOrigin } from "@/lib/api-client";
import { GraphCanvas } from "./graph-canvas";

export function AnalysisCanvas({
  session,
  onOpenFile,
}: {
  session: RepositorySession;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const { setAnalysisId } = useRepositorySession();
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] =
    useState<Extract<AnalysisJob, { status: "running" }>["stage"]>("parsing");
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  // Dev-only renderer-benchmark hook: a seeded recorded graph drives the
  // real workspace without a network analysis round trip. Production builds
  // never take this branch.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const seeded = sessionStorage.getItem("z1n_bench_graph");
    if (!seeded) return;
    // Applied one frame after mount: keeps the effect free of synchronous
    // state updates so the first server/client render stays identical.
    const frame = requestAnimationFrame(() => {
      try {
        const recorded = JSON.parse(seeded) as CodeGraph;
        setGraph(recorded);
        setAnalysisId(recorded.analysisId);
      } catch {
        /* Ignore malformed seeds; the normal flow stays available. */
      }
    });
    return () => cancelAnimationFrame(frame);
    // setAnalysisId is stable context state and not a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function analyze() {
    setError("");
    setBusy(true);
    setStage("parsing");
    dialog.current?.close();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await analyzeRepository(
        {
          origin: session.origin,
          consent: session.origin === "local" ? consent : false,
          files: session.files.map(({ path, content }) => ({ path, content })),
        },
        controller.signal,
        setStage,
      );
      setGraph(result);
      setAnalysisId(result.analysisId);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "Analysis failed.");
    } finally {
      request.current = null;
      setBusy(false);
    }
  }
  let server = "unavailable";
  try {
    server = apiOrigin();
  } catch {
    /* Address validation is reported when analysis starts. */
  }
  if (graph)
    return (
      <GraphCanvas graph={graph} session={session} onOpenFile={onOpenFile} />
    );
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true">
        ✳
      </div>
      <h1>Your files are ready.</h1>
      <p>Build an evidence-backed static map from the selected source files.</p>
      <button
        className="button primary"
        onClick={() => dialog.current?.showModal()}
        disabled={busy}
      >
        Analyze project →
      </button>
      {busy && (
        <p role="status">
          {
            {
              parsing: "Parsing selected source…",
              imports: "Resolving imports…",
              symbols: "Resolving symbols and calls…",
              frameworks: "Analyzing framework relationships…",
              validating: "Validating graph evidence…",
            }[stage]
          }{" "}
          <button
            className="text-link"
            onClick={() => request.current?.abort()}
          >
            Cancel
          </button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <dialog
        ref={dialog}
        className="panel"
        aria-labelledby="analysis-consent-title"
      >
        <h2 id="analysis-consent-title">Analyze selected files</h2>
        <p>
          Analysis sends {session.files.length} selected files to the configured
          backend at <strong>{server}</strong>. Source is processed in memory
          and is not executed. A remote backend receives the selected source.
        </p>
        {session.origin === "local" && (
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            I agree to send these local files to this backend for analysis.
          </label>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={session.origin === "local" && !consent}
            onClick={analyze}
          >
            Send and analyze
          </button>
        </div>
      </dialog>
    </div>
  );
}
