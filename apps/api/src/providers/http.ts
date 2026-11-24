import { ProviderError, providerErrorForStatus } from "./contracts";
export async function providerJson(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(12_000);
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
    if (!response.ok) throw providerErrorForStatus(response.status);
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
