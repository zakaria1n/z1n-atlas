import { createApp } from "./app";

async function main() {
  const port = Number(process.env.PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid API port.");
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await createApp(
    process.env.WEB_ORIGIN ?? "http://localhost:3000",
  );
  await app.listen({ port, host });
  process.stdout.write(`Z1N Atlas API listening on ${host}:${port}\n`);
}
main().catch(() => {
  process.stderr.write("Could not start the Z1N Atlas API.\n");
  process.exitCode = 1;
});
