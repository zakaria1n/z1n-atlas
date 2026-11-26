import { createApp } from "./app";
import { loadBackendDotenv, developerAiConfig } from "./config";

async function main() {
  // The backend owns its own credential file; loading never overrides
  // variables the shell already set. Invalid AI configuration stops the
  // server with a message that names the offending variable.
  loadBackendDotenv();
  developerAiConfig();
  disableLlmTracing();
  const port = Number(process.env.PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid API port.");
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await createApp(
    process.env.WEB_ORIGIN ?? "http://localhost:3000",
  );
  await app.listen({ port, host });
  const developerAi = developerAiConfig();
  if (developerAi.ENABLE_DEV_LLM_KEYS && process.env.NODE_ENV !== "production")
    process.stdout.write(
      `Server-managed AI keys are enabled for local development (providers: ${Object.keys(developerAi.keys).join(", ") || "none configured"}).\n`,
    );
  process.stdout.write(`Z1N Atlas API listening on ${host}:${port}\n`);
}
main().catch((error) => {
  process.stderr.write(
    error instanceof Error && /environment configuration/i.test(error.message)
      ? `${error.message}\n`
      : "Could not start the Z1N Atlas API.\n",
  );
  process.exitCode = 1;
});

/**
 * Prompts, source excerpts and credentials must never leave this process
 * through a tracing side channel. The LangChain tracing integrations are
 * off unless these environment variables turn them on, so the server pins
 * them off regardless of the surrounding shell.
 */
function disableLlmTracing(): void {
  for (const toggle of ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"])
    process.env[toggle] = "false";
  for (const variable of [
    "LANGCHAIN_ENDPOINT",
    "LANGSMITH_ENDPOINT",
    "LANGSMITH_PROJECT",
    "LANGSMITH_API_KEY",
  ])
    delete process.env[variable];
}
