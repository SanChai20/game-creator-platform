// Workers AI, used sparingly: a caller asks for one short answer and gets null whenever AI is not available,
// times out or says nothing useful, so every feature that uses it also works without it.
import type { Env } from './env';

export const TEXT_MODEL = '@cf/openai/gpt-oss-20b';  // $0.20 per M input tokens, $0.30 per M output tokens; writes prose (open implementation summaries)

export async function aiText(env: Env, system: string, user: string, maxTokens = 700, timeoutMs = 25000): Promise<string | null> {
  if (!env.AI || env.DEPLOY_DRIVER === 'local') return null;
  try {
    const run = env.AI.run(TEXT_MODEL as any, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, reasoning: { effort: 'low' } } as any) as Promise<any>;
    const out = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    const text = out?.choices?.[0]?.message?.content ?? out?.response ?? (Array.isArray(out?.output) ? out.output.flatMap((o: any) => o?.content || []).map((c: any) => c?.text || '').join('') : null);
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (e) {
    console.error('workers ai failed', String((e as Error)?.message || e).slice(0, 300));
    return null;
  }
}

// Cloudflare's decision models: they take a state and typed questions and return a probability for every allowed
// answer, so nothing has to be parsed out of prose. They bill input tokens only.
export const DECISION_MODELS = {
  clef: '@cf/cloudflare/clef',              // 27B, $0.24 per M input tokens: the copy judge (its answer can block a publish)
  'clef-flash': '@cf/cloudflare/clef-flash', // 9B, $0.038 per M input tokens: the "is it a game" check
} as const;
export type DecisionModel = keyof typeof DECISION_MODELS;
export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };

/** Asks a decision model; null whenever AI is not available, times out or answers out of shape. */
/** `extra` carries media for the vision-capable models, e.g. { images: ['data:image/png;base64,...'] }. */
export async function aiDecide(env: Env, model: DecisionModel, state: unknown, questions: Record<string, Question>, timeoutMs = 15000, extra: Record<string, unknown> = {}): Promise<Record<string, Answer> | null> {
  if (!env.AI || env.DEPLOY_DRIVER === 'local') return null;
  try {
    const run = env.AI.run(DECISION_MODELS[model] as any, { model, state, questions, ...extra } as any) as Promise<any>;
    const out = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    const answers = out?.answers;
    if (!answers || typeof answers !== 'object') return null;
    for (const [id, q] of Object.entries(questions)) {
      const a = answers[id];
      if (!a || a.type !== q.type) return null;
      if (q.type === 'noul' && !(typeof a.noul === 'number' && a.noul >= 0 && a.noul <= 1)) return null;
      if (q.type === 'choice' && !(typeof a.choice === 'string' && a.choice in q.criteria)) return null;
    }
    return answers;
  } catch (e) {
    console.error('workers ai decision failed', String((e as Error)?.message || e).slice(0, 300));
    return null;
  }
}
