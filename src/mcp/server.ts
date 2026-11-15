// MCP over Streamable HTTP, stateless: every POST carries one JSON-RPC message (or a batch) and gets a
// JSON response. No sessions and no server-initiated streams, which every current client supports.
import { AppError, type Env } from '../env';
import { userById } from '../auth';
import { getSettings } from '../settings';
import { PLATFORM_GUIDES, TOOLS, WEB_ONLY, guideText, type ToolCtx } from './tools';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const INSTRUCTIONS = `${WEB_ONLY}
This server deploys, verifies, publishes and versions web games for the account that authorized you, and hosts their services: player saves, shared game data and leaderboards in the platform database (game_data), and realtime multiplayer rooms (game_room). How you make the game is up to you; the platform does not prescribe engines, renderers or art. find_implementations and get_implementation show how other creators' live games were built when they chose to share it (never their code).
Call get_started first: it returns the rules a game must meet, the workflow, the account status and the platform services.
Typical loop: create_project → upload_files (or create_upload_url for big files and folders) → deploy_preview → read the report → fix → deploy_preview → publish.
A game is index.html plus the files it loads. The platform injects a global GCP; call GCP.ready() after the first playable frame.`;

async function dispatch(msg: any, c: ToolCtx): Promise<unknown | null> {
  const { id, method, params } = msg || {};
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid request');
  const isNote = id === undefined || id === null;
  const ok = (result: unknown) => (isNote ? null : { jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const want = String(params?.protocolVersion || '');
      const s = await getSettings(c.env);
      return ok({
        protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'game-creator', title: s.brand_name, version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: !!t.annotations?.readOnlyHint, destructiveHint: !!t.annotations?.destructiveHint, idempotentHint: !!t.annotations?.readOnlyHint, openWorldHint: false } })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}. Call tools/list.`);
      try {
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const missing = ((tool.inputSchema.required as string[]) || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
        if (missing.length) throw new AppError(400, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`, 'bad_request', `Expected: ${JSON.stringify(tool.inputSchema.properties)}`);
        const result = await tool.run(args, c);
        return ok({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }], isError: false });
      } catch (e) {
        if (!(e instanceof AppError)) console.error('tool failed', tool.name, e);
        const text = e instanceof AppError ? `${e.message}${e.hint ? `\nWhat to do: ${e.hint}` : ''}` : `Internal error in ${tool.name}: ${(e as Error).message}. Try again; if it keeps failing, call list_projects {project} to see the current state.`;
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list':
      return ok({ resources: PLATFORM_GUIDES.map((g) => ({ uri: `gcp://guides/${g.topic}`, name: g.topic, title: g.title, description: g.summary, mimeType: 'text/markdown' })) });
    case 'resources/read': {
      const m = String(params?.uri || '').match(/^gcp:\/\/guides\/([a-z0-9\-]+)$/);
      const g = m && await guideText(c.env, c.origin, m[1]);
      if (!g) return rpcError(id, -32002, 'Resource not found');
      return ok({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: g.markdown }] });
    }
    case 'resources/templates/list': return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [{ name: 'publish_a_game', title: 'Publish a web game', description: 'Deploy, verify and publish a web game you have made or are making.', arguments: [{ name: 'game', description: 'Which game, or where its files are', required: true }] }] });
    case 'prompts/get':
      if (params?.name !== 'publish_a_game') return rpcError(id, -32602, 'Unknown prompt');
      return ok({ description: 'Publish a web game', messages: [{ role: 'user', content: { type: 'text', text: `Put this web game on the platform and get it verified: ${params?.arguments?.game || '(ask me which game)'}\n\nCall get_started first and follow its workflow: create_project, upload the files, and deploy_preview until the version is verified. Then tell me where to play the preview, and publish only when I say so.` } }] });
    case 'logging/setLevel': return ok({});
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request: Request, env: Env, props: { userId?: string; client?: string }, origin: string): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'mcp-session-id, www-authenticate' };
  if (request.method !== 'POST') return new Response(JSON.stringify(rpcError(null, -32000, 'This server answers POST only (stateless Streamable HTTP).')), { status: 405, headers: { allow: 'POST', 'content-type': 'application/json', ...cors } });
  const user = props.userId ? await userById(env, props.userId) : null;
  if (!user || user.status !== 'active') return new Response(JSON.stringify(rpcError(null, -32001, 'The account behind this authorization is not active.')), { status: 403, headers: { 'content-type': 'application/json', ...cors } });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers: cors }); }
  const ctx: ToolCtx = { env, user, origin, client: String(props.client || 'agent').slice(0, 60) };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => dispatch(m, ctx)))).filter(Boolean);
    return out.length ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
  }
  const res = await dispatch(body, ctx);
  return res ? Response.json(res, { headers: cors }) : new Response(null, { status: 202, headers: cors });
}
