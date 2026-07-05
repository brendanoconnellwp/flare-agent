// One agent turn: model call → JSON parse → Zod validation, with exactly one
// retry (spec M2). Returns null when both attempts fail; the caller sends the
// safe fallback and pings the owner — the conversation never dies silently.

import type { ChatMessage, ModelProvider } from "./provider";
import { parseAgentTurn, type AgentTurn } from "./schema";

// A hung model call must not strand the caller: each attempt races a
// timeout, and a timeout counts as a failed attempt like any other error.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`model call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function runAgentTurn(
  provider: ModelProvider,
  system: string,
  history: ChatMessage[],
  timeoutMs = 20_000
): Promise<AgentTurn | null> {
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      raw = await withTimeout(provider.complete(messages), timeoutMs);
    } catch (err) {
      console.error(JSON.stringify({ event: "model_call_failed", attempt, error: String(err) }));
      continue;
    }
    const turn = parseAgentTurn(raw);
    if (turn) return turn;
    console.error(JSON.stringify({ event: "model_invalid_json", attempt, raw: raw.slice(0, 500) }));
  }
  return null;
}
