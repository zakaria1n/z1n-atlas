import type { AgentGenerate } from "../journey/agent";

/**
 * Development-only hook for local model acceptance: when enabled, the
 * AI-guided journey's AgentGenerate comes from an external module named by
 * DEV_AGENT_BRIDGE_PATH instead of a production provider adapter. The real
 * runJourneyAgent loop, its controlled tools, graph validation and HTTP
 * contracts are unchanged — only the model transport is external. Never
 * enabled in production, and never counted among the public providers.
 */
export const externalDevAgentEnabled = (): boolean =>
  process.env.NODE_ENV !== "production" &&
  process.env.ENABLE_DEV_LLM_KEYS === "true" &&
  Boolean(process.env.DEV_AGENT_BRIDGE_PATH);

export async function externalDevAgentGenerate(): Promise<AgentGenerate> {
  const bridgePath = process.env.DEV_AGENT_BRIDGE_PATH!;
  const bridge = (await import(bridgePath)) as {
    createAgentGenerate?: () => Promise<
      (input: {
        system: string;
        messages: unknown[];
        tools: unknown[];
        signal?: AbortSignal;
      }) => Promise<unknown>
    >;
  };
  if (typeof bridge.createAgentGenerate !== "function")
    throw new Error(
      "The development agent bridge must export createAgentGenerate().",
    );
  const generate = await bridge.createAgentGenerate();
  return async ({ system, messages, tools, signal }) => {
    const turn = (await generate({
      system,
      messages: messages as unknown[],
      tools: tools as unknown[],
      signal,
    })) as { kind: string; text?: string; toolCalls?: unknown[] };
    if (turn.kind === "tools" && Array.isArray(turn.toolCalls))
      return {
        kind: "tools",
        toolCalls: turn.toolCalls as {
          id: string;
          name: string;
          arguments: string;
        }[],
      };
    return { kind: "final", text: turn.text ?? "" };
  };
}
