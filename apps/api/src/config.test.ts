import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  developerAiConfig,
  loadDotenvFile,
  serverAiCredential,
} from "./config";

/** Writes the given lines to a temporary .env and loads it into the target. */
function loadDotenvFileFromText(lines: string[], target: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(join(tmpdir(), "z1n-env-"));
  try {
    const file = join(directory, ".env");
    writeFileSync(file, lines.join("\n"));
    loadDotenvFile(file, target);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("dotenv loading", () => {
  it("parses assignments, comments and quotes without overriding the shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "z1n-env-"));
    try {
      const file = join(directory, ".env");
      writeFileSync(
        file,
        [
          "# comment",
          "OPENAI_API_KEY= from-file ",
          'ANTHROPIC_API_KEY="quoted value"',
          "broken line without separator",
          "RUN_LIVE_LLM_TESTS=true",
        ].join("\n"),
      );
      const target: NodeJS.ProcessEnv = {
        OPENAI_API_KEY: "from-shell",
      };
      loadDotenvFile(file, target);
      expect(target.OPENAI_API_KEY).toBe("from-shell");
      expect(target.ANTHROPIC_API_KEY).toBe("quoted value");
      expect(target.RUN_LIVE_LLM_TESTS).toBe("true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("tolerates a missing .env file", () => {
    const target: NodeJS.ProcessEnv = {};
    loadDotenvFile(join(tmpdir(), "z1n-missing-env"), target);
    expect(target.OPENAI_API_KEY).toBeUndefined();
  });
  it("does not record assignments without a value", () => {
    const target: NodeJS.ProcessEnv = {};
    loadDotenvFileFromText(
      ["OPENAI_API_KEY=", "GEMINI_API_KEY=", "AI_DEFAULT_MODEL=   "],
      target,
    );
    expect("OPENAI_API_KEY" in target).toBe(false);
    expect("GEMINI_API_KEY" in target).toBe(false);
    expect("AI_DEFAULT_MODEL" in target).toBe(false);
  });
});

describe("developer AI configuration", () => {
  it("treats copied example variables left empty as unconfigured", () => {
    // A developer who fills in one key of the example file must not trip
    // validation for the keys left blank.
    const config = developerAiConfig({
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "g-key",
      ANTHROPIC_API_KEY: "   ",
      AI_DEFAULT_PROVIDER: "google",
      AI_DEFAULT_MODEL: "",
      RUN_LIVE_LLM_TESTS: "true",
      ENABLE_DEV_LLM_KEYS: "true",
    });
    expect(Object.keys(config.keys)).toEqual(["google"]);
    expect(config.AI_DEFAULT_PROVIDER).toBe("google");
    expect(config.AI_DEFAULT_MODEL).toBeUndefined();
    expect(config.RUN_LIVE_LLM_TESTS).toBe(true);
    expect(serverAiCredential({}, { GEMINI_API_KEY: "" })).toBeNull();
  });

  it("maps Gemini and Google spellings onto the google provider", () => {
    const config = developerAiConfig({
      GEMINI_API_KEY: "g-key",
      GOOGLE_DEFAULT_MODEL: "gemini-2.0-flash",
    });
    expect(config.keys.google).toBe("g-key");
    expect(config.models.google).toBe("gemini-2.0-flash");
  });

  it("rejects an invalid provider, model or flag with clear messages", () => {
    expect(() => developerAiConfig({ AI_DEFAULT_PROVIDER: "copilot" })).toThrow(
      /AI_DEFAULT_PROVIDER must be one of/,
    );
    expect(() => developerAiConfig({ AI_DEFAULT_MODEL: "bad model!" })).toThrow(
      /AI_DEFAULT_MODEL must be a model identifier/,
    );
    expect(() => developerAiConfig({ RUN_LIVE_LLM_TESTS: "yes" })).toThrow(
      /RUN_LIVE_LLM_TESTS must be exactly/,
    );
  });
});

describe("server-managed credentials", () => {
  it("stay disabled unless development-key access is enabled", () => {
    expect(
      serverAiCredential({ provider: "openai" }, { OPENAI_API_KEY: "k" }),
    ).toBeNull();
    expect(
      serverAiCredential(
        { provider: "openai" },
        { OPENAI_API_KEY: "k", ENABLE_DEV_LLM_KEYS: "false" },
      ),
    ).toBeNull();
  });

  it("resolve in development with defaults and per-provider models", () => {
    const credential = serverAiCredential(
      {},
      {
        OPENAI_API_KEY: "k",
        ENABLE_DEV_LLM_KEYS: "true",
        AI_DEFAULT_MODEL: "fallback-model",
      },
    );
    expect(credential).toEqual({
      provider: "openai",
      apiKey: "k",
      model: "fallback-model",
    });
    const specific = serverAiCredential(
      { provider: "anthropic" },
      {
        OPENAI_API_KEY: "k",
        ANTHROPIC_API_KEY: "a",
        ANTHROPIC_DEFAULT_MODEL: "claude-model",
        ENABLE_DEV_LLM_KEYS: "true",
        AI_DEFAULT_MODEL: "fallback-model",
      },
    );
    expect(specific).toEqual({
      provider: "anthropic",
      apiKey: "a",
      model: "claude-model",
    });
  });

  it("never resolve in production, whatever the flags say", () => {
    expect(
      serverAiCredential(
        {},
        {
          OPENAI_API_KEY: "k",
          ENABLE_DEV_LLM_KEYS: "true",
          NODE_ENV: "production",
        },
      ),
    ).toBeNull();
  });
});
