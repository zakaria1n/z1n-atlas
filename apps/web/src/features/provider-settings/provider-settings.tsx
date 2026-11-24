"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { providerRequestSchema, type Provider } from "@z1n/contracts";
import { apiOrigin, discoverModels } from "@/lib/api-client";
import { useProviderSession } from "./provider-session";

export function ProviderSettings() {
  const { session, setSession } = useProviderSession();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function reset(provider: Provider, apiKey: string) {
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
    setMessage("");
    setSession({ provider, apiKey, model: "", list: null });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !providerRequestSchema.safeParse({
        provider: session.provider,
        apiKey: session.apiKey,
      }).success
    ) {
      setMessage("Enter an API key without spaces or line breaks.");
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setMessage("");
    try {
      const list = await discoverModels(
        { provider: session.provider, apiKey: session.apiKey },
        controller.signal,
      );
      if (pending.current !== controller) return;
      setSession({ ...session, model: "", list });
      setMessage(
        list.models.length
          ? "Choose a model from the list."
          : "No supported model candidates were returned.",
      );
    } catch (error) {
      if (pending.current !== controller) return;
      setMessage(
        error instanceof Error ? error.message : "Could not retrieve models.",
      );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }
  return (
    <section className="provider-settings" aria-labelledby="provider-heading">
      <div>
        <p className="eyebrow">Bring your own key</p>
        <h2 id="provider-heading">Your provider, your choice.</h2>
        <p>
          Keys stay in this browser tab’s memory and are cleared on reload. When
          you retrieve models, the key is sent to <strong>{apiOrigin()}</strong>{" "}
          and forwarded to the selected provider.
        </p>
        <p>
          Model discovery checks the list only; it does not verify that
          generation works. AI chat and Feature Journey are not yet available.
        </p>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="provider">Provider</label>
        <select
          id="provider"
          value={session.provider}
          onChange={(event) => reset(event.target.value as Provider, "")}
        >
          <option value="openai">OpenAI</option>
          <option value="google">Google Gemini</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          type="password"
          value={session.apiKey}
          onChange={(event) => reset(session.provider, event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
        />
        <div className="provider-actions">
          <button
            className="button provider-submit"
            disabled={loading || !session.apiKey}
            type="submit"
          >
            {loading ? "Retrieving models…" : "Retrieve models"}
          </button>
          <button
            className="provider-clear"
            type="button"
            onClick={() => reset(session.provider, "")}
          >
            Clear key
          </button>
        </div>
        <p role="status" aria-live="polite">
          {message}
        </p>
        {session.list && (
          <>
            <label htmlFor="model">Model</label>
            <select
              id="model"
              value={session.model}
              onChange={(event) =>
                setSession({ ...session, model: event.target.value })
              }
            >
              <option value="">Select a model</option>
              {session.list.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.compatibility})
                </option>
              ))}
            </select>
            <p>
              {session.list.notice}
              {session.list.partial &&
                " This list is incomplete; the provider has more results."}
            </p>
          </>
        )}
      </form>
    </section>
  );
}
