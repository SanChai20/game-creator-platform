// The dynamic dispatch Worker for Workers for Platforms. A wildcard route (*.<GAME_HOST>/*) sends every game request
// here; the first label of the host is the game's script name (gcp-<pid>-<env>), so routing needs no lookup. Deployed
// on its own with dispatcher/wrangler.jsonc once DEPLOY_DRIVER is "dispatch"; the platform Worker keeps its own
// DISPATCHER binding only for health checks. Kept separate from the platform Worker so game hosts never reach the
// platform's pages, API or static assets. See docs/workers-for-platforms.md.
import type { Env } from './env';
import { dispatchGame } from './dispatch';
import { matchGameRequest } from './hosting';
import { getSettings } from './settings';

type DispatcherEnv = Pick<Env, 'DB' | 'DEPLOY_DRIVER' | 'GAME_HOST' | 'GAME_OUTBOUND' | 'PUBLIC_ORIGIN'> & { DISPATCHER: DispatchNamespace };

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url);
    const m = matchGameRequest({ ...env, DEPLOY_DRIVER: 'dispatch' }, url) || { script: null };
    const s = await getSettings(env as unknown as Env);
    return dispatchGame(request, env, env.DISPATCHER, s, m, env.PUBLIC_ORIGIN || '');
  },
} satisfies ExportedHandler<DispatcherEnv>;
