// Workers AI, used sparingly: a caller asks for one short answer and gets null whenever AI is not available,
// times out or says nothing useful, so every feature that uses it also works without it.
import type { Env } from './env';

export const TEXT_MODEL = '@cf/openai/gpt-oss-20b';  // $0.20 per M input tokens, $0.30 per M output tokens

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
