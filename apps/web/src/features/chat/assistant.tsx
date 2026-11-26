"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatAnswer } from "@z1n/contracts";
import { useProviderSession } from "@/features/provider-settings/provider-session";
import { useServerAiStatus } from "@/features/provider-settings/server-ai";
import {
  useRepositorySession,
  type RepositorySession,
} from "@/features/repository-import/repository-session";
import { apiOriginLabel, askRepository } from "@/lib/api-client";

export function Assistant({
  session,
  onOpenCitation,
}: {
  session: RepositorySession | null;
  onOpenCitation: (path: string, line: number) => void;
}) {
  const { session: provider } = useProviderSession();
  const serverAi = useServerAiStatus();
  const server = serverAi?.available ? serverAi : null;
  const ownKey = Boolean(provider.apiKey && provider.model);
  const serverManaged = server !== null;
  const { analysisId } = useRepositorySession();
  const [question, setQuestion] = useState("");
  const [consent, setConsent] = useState(false);
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([]);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !consent || (!ownKey && !serverManaged)) return;
    cancel();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    setAnswer(null);
    try {
      const result = await askRepository(
        {
          question,
          files: session.files.map(({ path, content }) => ({ path, content })),
          origin: session.origin,
          consent: true,
          providerConsent: true,
          analysisId,
          // Bounded follow-up context: the last two exchanges only.
          history: turns.slice(-4),
          ...(ownKey
            ? {
                ai: {
                  provider: provider.provider,
                  apiKey: provider.apiKey,
                  model: provider.model,
                  providerConsent: true as const,
                },
              }
            : { serverAi: true }),
        },
        controller.signal,
      );
      if (pending.current === controller) {
        setAnswer(result);
        setTurns((current) => [
          ...current,
          { role: "user", text: question },
          {
            role: "assistant",
            text:
              result.claims.map((claim) => claim.text).join(" ") ||
              result.uncertainties.join(" "),
          },
        ]);
      }
    } catch (reason) {
      if (pending.current === controller)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not answer this question.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }
  if (!session) return <p>Import a project before asking about its source.</p>;
  if (!ownKey && !serverManaged)
    return (
      <p>
        Choose a provider, key and model in{" "}
        <Link href="/settings" className="text-link">
          Settings
        </Link>{" "}
        to ask a question. A development server with backend keys can also
        answer without a personal key.
      </p>
    );
  return (
    <div className="assistant-content">
      <p>
        Ask about the selected source. Answers use bounded excerpts and may be
        incomplete; a citation confirms its source location, not the correctness
        of the explanation.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="assistant-question">Your question</label>
        <textarea
          id="assistant-question"
          rows={3}
          maxLength={1000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          required
          minLength={2}
        />
        <label className="assistant-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />{" "}
          <span>
            I agree to send the selected files to{" "}
            <strong>{apiOriginLabel()}</strong> for analysis and relevant
            excerpts to{" "}
            {ownKey
              ? "the selected AI provider"
              : `the backend's ${server?.provider} provider`}
            . Provider requests may incur charges.
          </span>
        </label>
        <div className="provider-actions">
          <button
            className="button provider-submit"
            type="submit"
            disabled={loading || !consent || question.trim().length < 2}
          >
            Ask
          </button>
          {loading && (
            <button type="button" className="provider-clear" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
      <p role="status" aria-live="polite">
        {loading ? "Finding evidence and preparing an answer…" : error}
      </p>
      {answer && (
        <div className="assistant-answer">
          <h3>Answer</h3>
          {answer.claims.map((claim, index) => (
            <div key={index}>
              <p>{claim.text}</p>
              <ul>
                {claim.citations.map((citation) => (
                  <li key={citation.id}>
                    <button
                      className="text-link citation-button"
                      type="button"
                      onClick={() =>
                        onOpenCitation(citation.filePath, citation.startLine)
                      }
                    >
                      {citation.filePath}:{citation.startLine}
                      {citation.endLine !== citation.startLine &&
                        `–${citation.endLine}`}
                    </button>
                    {citation.relationship && (
                      <span>
                        {" "}
                        · {citation.relationship.kind} (
                        {citation.relationship.confidence})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {answer.uncertainties.length > 0 && (
            <>
              <h3>Uncertainty</h3>
              <ul>
                {answer.uncertainties.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
