"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CodeGraph, GraphEdge, Journey } from "@z1n/contracts";
import type { RepositorySession } from "@/features/repository-import/repository-session";
import { apiOrigin, requestJourney } from "@/lib/api-client";

const descriptions: Partial<Record<GraphEdge["kind"], string>> = {
  calls: "A static call links these symbols.",
  requests: "This code contains an HTTP request.",
  "http-route": "The request and route are a possible match.",
  handles: "The framework route points to this handler.",
  "database-access": "The source contains a supported database operation.",
  renders: "The framework convention links this entry to a page.",
};

export function JourneyPanel({
  session,
  graph,
  journey,
  onJourney,
  onOpenFile,
}: {
  session: RepositorySession;
  graph: CodeGraph;
  journey: Journey | null;
  onJourney: (value: Journey | null) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [goal, setGoal] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!consent) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    onJourney(null);
    try {
      const result = await requestJourney(
        {
          goal,
          origin: session.origin,
          consent: true,
          files: session.files.map(({ path, content }) => ({ path, content })),
        },
        graph,
        controller.signal,
      );
      if (pending.current === controller) onJourney(result);
    } catch (reason) {
      if (pending.current === controller)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not compute a journey.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details className="journey-panel">
      <summary>Feature Journey</summary>
      <p>
        Find a candidate path by symbol, file or feature name. This uses the
        static graph without an AI request.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="journey-goal">Feature or symbol</label>
        <input
          id="journey-goal"
          maxLength={500}
          minLength={2}
          required
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <label className="assistant-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            Send the selected files again to {apiOrigin()} for analysis.
          </span>
        </label>
        <div className="provider-actions">
          <button
            className="button provider-submit"
            disabled={!consent || busy || goal.trim().length < 2}
          >
            Find path
          </button>
          {busy && (
            <button
              type="button"
              className="provider-clear"
              onClick={() => {
                pending.current?.abort();
                pending.current = null;
                setBusy(false);
              }}
            >
              Cancel
            </button>
          )}
          {journey && (
            <button
              type="button"
              className="provider-clear"
              onClick={() => onJourney(null)}
            >
              Clear path
            </button>
          )}
        </div>
      </form>
      <p role="status">{busy ? "Finding a path…" : error}</p>
      {journey && (
        <>
          <ul>
            {journey.uncertainties.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {journey.nodeIds.length > 0 && (
            <ol className="journey-steps">
              {journey.nodeIds.map((id, index) => {
                const node = graph.nodes.find((item) => item.id === id)!;
                const edge = index
                  ? graph.edges.find(
                      (item) => item.id === journey.edgeIds[index - 1],
                    )
                  : undefined;
                const evidence = edge
                  ? [edge.evidenceId, ...(edge.supportingEvidenceIds ?? [])]
                      .map((item) =>
                        graph.evidence.find((proof) => proof.id === item),
                      )
                      .filter((item) => item !== undefined)
                  : [];
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="text-link citation-button"
                      onClick={() => onOpenFile(node.path, node.startLine)}
                    >
                      {node.name ?? node.path}
                    </button>
                    <span> · {node.kind ?? "file"}</span>
                    {edge && (
                      <>
                        <p>
                          {descriptions[edge.kind] ??
                            "A source relationship was found."}{" "}
                          ({edge.confidence})
                        </p>
                        <ul>
                          {evidence.map((proof) => (
                            <li key={proof.id}>
                              <button
                                type="button"
                                className="text-link citation-button"
                                onClick={() =>
                                  onOpenFile(proof.filePath, proof.startLine)
                                }
                              >
                                {proof.filePath}:{proof.startLine}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </details>
  );
}
