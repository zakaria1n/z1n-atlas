"use client";
import { useEffect, useState } from "react";
import { backendUrl } from "@/lib/api-client";

export type ServerAiStatus =
  { available: false } | { available: true; provider: string; model?: string };

/**
 * Asks the backend whether it serves AI with its own configured credential.
 * The answer never contains a key — only the provider and, when configured,
 * the default model name.
 */
export function useServerAiStatus(): ServerAiStatus | null {
  const [status, setStatus] = useState<ServerAiStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${backendUrl()}/api/ai/status`, { signal: controller.signal })
      .then((response) =>
        response.ok ? response.json() : { available: false },
      )
      .then((value) => setStatus(value))
      .catch(() => setStatus({ available: false }));
    return () => controller.abort();
  }, []);
  return status;
}
