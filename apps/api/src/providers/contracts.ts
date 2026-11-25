import type { ModelList, Provider } from "@z1n/contracts";
export type ProviderErrorCode =
  | "INVALID_KEY"
  | "FORBIDDEN"
  | "RATE_LIMIT"
  | "UNSUPPORTED_MODEL"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";
export class ProviderError extends Error {
  /**
   * The provider's own response body, attached by the HTTP layer for
   * internal diagnosis only. Never placed in the message: bodies may echo
   * credentials, and errors end up in logs and responses.
   */
  providerDetail?: string;
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export interface ProviderAdapter {
  readonly provider: Provider;
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelList>;
}
export function providerErrorForStatus(status: number): ProviderError {
  if (status === 401)
    return new ProviderError(
      "INVALID_KEY",
      "The provider rejected the API key.",
    );
  if (status === 403)
    return new ProviderError(
      "FORBIDDEN",
      "The key does not have permission for this request.",
    );
  if (status === 404)
    return new ProviderError(
      "UNSUPPORTED_MODEL",
      "The provider does not offer this model, or no longer offers it to this account. Choose a current model.",
    );
  if (status === 429)
    return new ProviderError(
      "RATE_LIMIT",
      "The provider rate limit was reached. Try again later.",
    );
  return new ProviderError(
    "UNAVAILABLE",
    "The provider is unavailable or could not complete the request.",
  );
}
