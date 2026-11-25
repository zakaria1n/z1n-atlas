import { ProviderError, providerErrorForStatus } from "./contracts";

/**
 * Keeps the provider's own explanation available for internal diagnosis — a
 * discontinued model naming its successor, for instance — without ever
 * placing it in the message: error bodies may echo credentials, so they
 * never reach logs, responses or stringified errors.
 */
async function withProviderDetail(
  error: ProviderError,
  response: Response,
): Promise<ProviderError> {
  try {
    const text = await response.text();
    const snippet = text
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .trim()
      .slice(0, 300);
    if (snippet) error.providerDetail = snippet;
  } catch {
    // The status-mapped error is still the answer when the body is unreadable.
  }
  return error;
}
export async function providerJson(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  body?: unknown,
  timeoutMs = 12_000,
): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const response = await fetcher(url, {
      headers,
      redirect: "error",
      cache: "no-store",
      signal: combined,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw await withProviderDetail(
        providerErrorForStatus(response.status),
        response,
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new ProviderError(
        "INVALID_RESPONSE",
        "The provider returned an empty response.",
      );
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1_000_000) {
        await reader.cancel();
        throw new ProviderError(
          "INVALID_RESPONSE",
          "The provider response exceeded the size limit.",
        );
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "The provider returned an invalid response.",
      );
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "UNAVAILABLE",
      "The provider could not be reached or the request timed out.",
    );
  }
}
