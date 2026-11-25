"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CodeGraph, GraphEdge, Journey } from "@z1n/contracts";
import type { RepositorySession } from "@/features/repository-import/repository-session";
import { apiOriginLabel, requestJourney } from "@/lib/api-client";
import { useProviderSession } from "@/features/provider-settings/provider-session";
import Link from "next/link";

const descriptions: Partial<Record<GraphEdge["kind"], string>> = {
  calls: "A static call links these symbols.",
  requests: "This code contains an HTTP request.",
  "http-route": "The request and route are a possible match.",
  handles: "The framework route points to this handler.",
  "handles-event": "A React event attribute references this handler.",
  "database-access": "The source contains a supported database operation.",
  renders: "A component renders this one, or a page renders this component.",
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
  const provider = useProviderSession().session;
  const configured = Boolean(provider.apiKey && provider.model);
  const [aiMode, setAiMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !consent ||
      (aiMode && configured && (!provider.apiKey || !provider.model))
    )
      return;
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
          analysisId: graph.analysisId,
          files: session.files.map(({ path, content }) => ({ path, content })),
          ...(aiMode && configured
            ? {
                ai: {
                  provider: provider.provider,
                  apiKey: provider.apiKey,
                  model: provider.model,
                  providerConsent: true as const,
                },
              }
            : {}),
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
  const explanation = (id: string) =>
    journey?.explanations?.find((item) => item.nodeId === id)?.text;
  return (
    <details className="journey-panel">
      <summary>Feature Journey</summary>
      <p>
        Explain how a feature runs through the analyzed code. Every step cites
        source evidence; nothing is shown that the graph does not contain.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="journey-goal">Feature or question</label>
        <input
          id="journey-goal"
          maxLength={500}
          minLength={2}
          required
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        {configured ? (
          <fieldset className="journey-mode">
            <legend>Exploration mode</legend>
            <label className="assistant-consent">
              <input
                type="radio"
                name="journey-mode"
                checked={aiMode}
                onChange={() => setAiMode(true)}
              />
              <span>
                <strong>AI-guided.</strong> {provider.provider} explores the
                code with controlled tools. The question and relevant excerpts
                are sent to the provider and may incur charges.
              </span>
            </label>
            <label className="assistant-consent">
              <input
                type="radio"
                name="journey-mode"
                checked={!aiMode}
                onChange={() => setAiMode(false)}
              />
              <span>
                <strong>Static path.</strong> Deterministic ranking by symbol
                and file names in the backend. No AI understanding, no provider
                call.
              </span>
            </label>
          </fieldset>
        ) : (
          <p>
            <strong>Static path exploration.</strong> Deterministic ranking by
            symbol and file names — not AI understanding. Configure a provider
            in{" "}
            <Link href="/settings" className="text-link">
              Settings
            </Link>{" "}
            for AI-guided journeys.
          </p>
        )}
        <label className="assistant-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            Send the selected files again to {apiOriginLabel()} for analysis.
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
          <p className="journey-mode-badge">
            {journey.mode === "ai"
              ? "AI-guided journey"
              : "Static path · deterministic name ranking, not AI understanding"}
          </p>
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
                const text = explanation(id);
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
                    {text && <p className="journey-explanation">{text}</p>}
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
