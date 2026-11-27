import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Provider } from "@z1n/contracts";

export const aiProviders: Provider[] = ["openai", "google", "anthropic"];

/**
 * An assignment with no value (`KEY=`) or only spaces means "not configured",
 * never an empty credential: a developer who fills in one key of a copied
 * example file must not trip validation for the keys left blank.
 */
const notBlank = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const keySchema = z.preprocess(
  notBlank,
  z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[^\s\x00-\x1f\x7f]+$/)
    .optional(),
);
const modelSchema = z.preprocess(
  notBlank,
  z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._:/-]+$/)
    .optional(),
);
const booleanSchema = z.preprocess(
  notBlank,
  z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
);

const environmentSchema = z.object({
  OPENAI_API_KEY: keySchema,
  GEMINI_API_KEY: keySchema,
  GOOGLE_API_KEY: keySchema,
  ANTHROPIC_API_KEY: keySchema,
  AI_DEFAULT_PROVIDER: z.preprocess(
    notBlank,
    z.enum(["openai", "google", "anthropic"]).optional(),
  ),
  AI_DEFAULT_MODEL: modelSchema,
  OPENAI_DEFAULT_MODEL: modelSchema,
  GEMINI_DEFAULT_MODEL: modelSchema,
  GOOGLE_DEFAULT_MODEL: modelSchema,
  ANTHROPIC_DEFAULT_MODEL: modelSchema,
  RUN_LIVE_LLM_TESTS: booleanSchema,
  ENABLE_DEV_LLM_KEYS: booleanSchema,
});

export type DeveloperAiConfig = z.infer<typeof environmentSchema> & {
  /** Gemini accepts both spellings; the provider id is "google". */
  keys: Partial<Record<Provider, string>>;
  models: Partial<Record<Provider, string>>;
};

/**
 * Reads a `.env` file into process.env without overriding values that are
 * already set, so the shell and the CI always win over the file. An
 * assignment without a value is not recorded, because an empty variable
 * means "not configured" throughout this module.
 */
export function loadDotenvFile(filePath: string, target = process.env): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value);
    if (quoted) value = quoted[1];
    if (!value || name in target) continue;
    target[name] = value;
  }
}

/**
 * The backend `.env` next to the compiled server. The compiled CommonJS
 * build knows its own directory; the test runner falls back to the workspace
 * layout relative to the current directory.
 */
export function backendDotenvPath(): string {
  if (typeof __dirname === "string") return path.join(__dirname, "..", ".env");
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, "apps", "api", ".env"),
    path.join(cwd, ".env"),
  ])
    if (existsSync(candidate)) return candidate;
  return path.join(cwd, ".env");
}

export function loadBackendDotenv(target = process.env): void {
  loadDotenvFile(backendDotenvPath(), target);
}

/**
 * Validates the AI-related environment. Unknown variables are ignored and a
 * missing key disables nothing on its own: features that need no provider
 * keep working. An invalid value fails loudly with the variable named.
 */
export function developerAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeveloperAiConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => {
        const name = issue.path.join(".") || "environment";
        if (name.includes("AI_DEFAULT_PROVIDER"))
          return "AI_DEFAULT_PROVIDER must be one of openai, google, anthropic.";
        if (name.endsWith("_API_KEY"))
          return `${name} must be a single-line token without spaces or control characters.`;
        if (name.endsWith("_MODEL"))
          return `${name} must be a model identifier such as gpt-4o-mini, matching letters, digits, dot, underscore, colon, dash or slash.`;
        if (
          name.includes("RUN_LIVE_LLM_TESTS") ||
          name.includes("ENABLE_DEV_LLM_KEYS")
        )
          return `${name} must be exactly "true" or "false".`;
        return `${name}: ${issue.message}`;
      })
      .join(" ");
    throw new Error(`Invalid environment configuration. ${problems}`);
  }
  const value = parsed.data;
  const geminiKey = value.GEMINI_API_KEY ?? value.GOOGLE_API_KEY;
  return {
    ...value,
    keys: {
      ...(value.OPENAI_API_KEY ? { openai: value.OPENAI_API_KEY } : {}),
      ...(geminiKey ? { google: geminiKey } : {}),
      ...(value.ANTHROPIC_API_KEY
        ? { anthropic: value.ANTHROPIC_API_KEY }
        : {}),
    },
    models: {
      ...(value.OPENAI_DEFAULT_MODEL
        ? { openai: value.OPENAI_DEFAULT_MODEL }
        : {}),
      ...(value.GEMINI_DEFAULT_MODEL || value.GOOGLE_DEFAULT_MODEL
        ? {
            google: value.GEMINI_DEFAULT_MODEL ?? value.GOOGLE_DEFAULT_MODEL!,
          }
        : {}),
      ...(value.ANTHROPIC_DEFAULT_MODEL
        ? { anthropic: value.ANTHROPIC_DEFAULT_MODEL }
        : {}),
    },
  };
}

export type ServerAiCredential = {
  provider: Provider;
  apiKey: string;
  /** Null when no model is configured; the caller may discover one. */
  model: string | null;
};

/**
 * Resolves the backend-owned credential for a request that opted into
 * server-managed AI. It stays null unless development-key access is enabled
 * and the process is not in production, so a stray environment variable can
 * never expose keys in a deployed instance. User BYOK requests never reach
 * this path.
 */
export function serverAiCredential(
  requested?: { provider?: Provider; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): ServerAiCredential | null {
  const config = developerAiConfig(env);
  if (!config.ENABLE_DEV_LLM_KEYS) return null;
  if (env.NODE_ENV === "production") return null;
  const provider =
    requested?.provider ??
    config.AI_DEFAULT_PROVIDER ??
    aiProviders.find((candidate) => config.keys[candidate]);
  if (!provider) return null;
  const apiKey = config.keys[provider];
  if (!apiKey) return null;
  const model =
    requested?.model ??
    config.models[provider] ??
    config.AI_DEFAULT_MODEL ??
    null;
  return { provider, apiKey, model };
}

/** Whether live provider tests may run; used only by the opt-in suite. */
export function liveLlmTestsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return developerAiConfig(env).RUN_LIVE_LLM_TESTS === true;
}

/**
 * Local semantic retrieval is an opt-in mode: the embedding model and its
 * runtime are heavy dependencies with a one-time model download, so hybrid
 * ranking only activates when the operator asks for it. Lexical retrieval
 * stays the default and is never described as hybrid.
 */
export const semanticRetrievalEnabled = (): boolean =>
  process.env.Z1N_SEMANTIC_RETRIEVAL === "true";
