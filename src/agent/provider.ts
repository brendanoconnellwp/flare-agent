// Model provider adapter. The engine talks to this interface only; which
// model and which provider are env vars (MODEL_PROVIDER, MODEL_ID), never
// code. Workers AI is the default, always fronted by AI Gateway when
// AI_GATEWAY_ID is configured (binding calls are account-authenticated, so
// the gateway token is only needed by external REST callers).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelProvider {
  complete(messages: ChatMessage[]): Promise<string>;
}

export function createProvider(env: Env): ModelProvider {
  const name: string = env.MODEL_PROVIDER;
  if (name === "workers-ai") return workersAiProvider(env);
  if (name === "mock") return mockProvider(env);
  throw new Error(`Unknown MODEL_PROVIDER "${name}" — add an adapter in src/agent/provider.ts`);
}

// Test double, activated only when the vitest config sets MODEL_PROVIDER to
// "mock" (never by a deployed wrangler config). Pops scripted responses from
// the test_model_script D1 table, which tests seed before sending a message;
// an empty table means every model call fails — the spec's "model mocked to
// FAIL". D1 is the seam because DO code runs outside the test module graph,
// where vi.mock cannot reach.
function mockProvider(env: Env): ModelProvider {
  return {
    async complete(): Promise<string> {
      const row = await env.DB.prepare(
        "DELETE FROM test_model_script WHERE id = (SELECT MIN(id) FROM test_model_script) RETURNING response"
      ).first<{ response: string }>();
      if (!row) throw new Error("mock model: no scripted response seeded");
      // Sentinel for timeout tests: a model call that never returns.
      if (row.response === "__HANG__") return new Promise<string>(() => {});
      return row.response;
    },
  };
}

// Workers AI text models answer in one of two shapes depending on model
// generation: legacy { response } or OpenAI-style { choices[0].message.content }.
function extractText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r.response === "string") return r.response;
  const content = r.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

function workersAiProvider(env: Env): ModelProvider {
  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      if (!env.AI_GATEWAY_ID) {
        console.warn(
          JSON.stringify({ event: "ai_gateway_bypassed", why: "AI_GATEWAY_ID not set — set it in .dev.vars / secrets" })
        );
      }
      const result: unknown = await env.AI.run(
        env.MODEL_ID,
        { messages, max_tokens: 600, temperature: 0.2 },
        env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {}
      );
      const text = extractText(result);
      if (text !== null) return text;
      throw new Error(
        `Workers AI returned an unexpected response shape for ${env.MODEL_ID}: ${JSON.stringify(result)?.slice(0, 300)}`
      );
    },
  };
}
