// MCP over Streamable HTTP, stateless: every POST carries one JSON-RPC message (or a batch) and gets a
// JSON response. No sessions and no server-initiated streams, which every current client supports.
import { AppError, type Env } from '../env';
import { userById } from '../auth';
import { assetText } from '../projects';
import { getSettings } from '../settings';
import { TOOLS, type ToolCtx } from './tools';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const INSTRUCTIONS = `This server lets you build, verify and publish web games for the account that authorized you.
Call get_started first: it returns the workflow, the three hard rules, and the available guides, kits and templates.
Typical loop: create_project → put_files / edit_file → check_project → deploy_preview → read the report → fix → deploy_preview → publish.
Games are plain web pages (index.html + files). The platform injects a global GCP; call GCP.ready() after the first playable frame.
Guides and kits are optional help. Gameplay, art and rendering are your choice. If you are unsure which rendering approach fits, call recommend_pipeline.`;

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
        const text = e instanceof AppError ? `${e.message}${e.hint ? `\nWhat to do: ${e.hint}` : ''}` : `Internal error in ${tool.name}: ${(e as Error).message}. Try again; if it keeps failing, call get_project to see the current state.`;
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list': {
      const idx = JSON.parse((await assetText(c.env, '/guides/index.json')) || '{"guides":[]}');
      return ok({ resources: idx.guides.map((g: any) => ({ uri: `gcp://guides/${g.topic}`, name: g.topic, title: g.title, description: g.summary, mimeType: 'text/markdown' })) });
    }
    case 'resources/read': {
      const m = String(params?.uri || '').match(/^gcp:\/\/guides\/([a-z0-9\-]+)$/);
      const text = m && await assetText(c.env, `/guides/${m[1]}.md`);
      if (!text) return rpcError(id, -32002, 'Resource not found');
      return ok({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: text.replaceAll('{{ORIGIN}}', c.origin) }] });
    }
    case 'resources/templates/list': return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [{ name: 'make_a_game', title: 'Make a game', description: 'Build, verify and publish a web game from a short idea.', arguments: [{ name: 'idea', description: 'What the game is about', required: true }] }] });
    case 'prompts/get':
      if (params?.name !== 'make_a_game') return rpcError(id, -32602, 'Unknown prompt');
      return ok({ description: 'Make a game', messages: [{ role: 'user', content: { type: 'text', text: `Make this game on the Game Creator platform and get it verified: ${params?.arguments?.idea || '(ask me for the idea)'}\n\nCall get_started first and follow its workflow. Ask recommend_pipeline which rendering approach fits, start from a template, keep check_project clean, and iterate on deploy_preview until the version is verified. Then tell me where to play the preview before publishing.` } }] });
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
