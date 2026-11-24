// MCP over Streamable HTTP, stateless: every POST carries one JSON-RPC message (or a batch) and gets a
// JSON response. No sessions and no server-initiated streams, which every current client supports.
import { AppError, type Env } from '../env';
import { rateLimit, userById } from '../auth';
import { getSettings } from '../settings';
import { PLATFORM_GUIDES, TEMPLATES, TOOLS, WEB_ONLY, WithImages, guideText, type ToolCtx } from './tools';
import { b64 } from '../util';
import { DISCOVERY, NOT_PROVIDED, platformServices } from './services';
import { checkArgs, listed, missingArgs, normalizeArgs, signature } from './schema';
import { SCOPE, toolLines } from './overview';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export const INSTRUCTIONS = `${WEB_ONLY}
This server is the game platform for the account that authorized you: it hosts web games you build with the creator you work for, gives them a platform SDK, and tests them and brings back feedback.
What the platform covers: ${SCOPE.covers}
What it leaves to you and the creator. ${SCOPE.yours}
${SCOPE.self_contained}

The tools, by what they are for:
${toolLines()}

Typical loop: get_started → create_project → upload_files (or create_upload_url) → deploy_preview → read the report → look with debug_preview and read creator_feedback → fix → deploy_preview → game_metadata → publish {dry_run: true} → publish (with the creator's go-ahead).
The page contract in short: index.html at the root plus the files it loads by relative path, no build step on the platform. The platform injects a global GCP (never bundle it); call GCP.ready() once the first playable frame is drawn. Recommended: draw what the player sees in canvases and register GCP.test.onCapture and GCP.test.onState, so feedback screenshots are the exact frame and debug_preview shows where the game is (get_started {topic: "contract"}). The full testing and feedback loop: get_started {topic: "testing"}. Read creator_feedback at the start of a session and whenever an answer says feedback is waiting.`;

const MAX_BATCH = 20;           // JSON-RPC messages in one POST
const CALLS_PER_HOUR = 1200;    // tools/call per account (a busy agent makes a few hundred an hour)

/** The hourly allowance of tool calls, said so an agent knows it is not its arguments and when to carry on. */
async function callAllowance(c: ToolCtx) {
  try { await rateLimit(c.env, 'mcp:' + c.user.id, CALLS_PER_HOUR, 3600); }
  catch (e) {
    if (e instanceof AppError && e.status === 429) throw new AppError(429, `This account made more than ${CALLS_PER_HOUR} tool calls in the last hour, so calls are refused for now. Nothing was changed by this call.`, 'rate_limited', 'Wait a few minutes and call again. Batch work: upload_files takes up to 40 files and edits in one call, create_upload_url sends a whole folder, and list_versions {project, version} waits for a report by itself, so there is no need to poll.');
    throw e;
  }
}

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
        serverInfo: { name: 'hearthcade', title: s.brand_name, version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map(listed) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}. Call tools/list.`);
      try {
        // repaired where the intent is unambiguous (a JSON string, a wrapped object, "true", "3", project_id), then held to the schema
        const args = normalizeArgs(tool.inputSchema as any, params?.arguments);
        const missing = missingArgs(tool.inputSchema as any, args);
        if (missing) throw new AppError(400, `${missing} Nothing was changed.`, 'bad_request', signature(tool.inputSchema as any));
        const wrong = checkArgs(tool.inputSchema as any, args);
        if (wrong) throw new AppError(400, `${wrong} Nothing was changed.`, 'bad_request', signature(tool.inputSchema as any));
        await callAllowance(c);
        const result = await tool.run(args, c);
        if (result instanceof WithImages) {
          return ok({ content: [{ type: 'text', text: JSON.stringify(result.data, null, 1) }, ...result.images.map((i) => ({ type: 'image', data: b64(i.data), mimeType: i.type }))], isError: false });
        }
        return ok({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }], isError: false });
      } catch (e) {
        if (!(e instanceof AppError)) console.error('tool failed', tool.name, e);
        const text = e instanceof AppError ? `${e.message}${e.hint ? `\nWhat to do: ${e.hint}` : ''}` : `Internal error in ${tool.name}: ${(e as Error).message}. Try again; if it keeps failing, call list_projects {project} to see the current state.`;
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list':
      return ok({ resources: [
        { uri: 'gcp://services', name: 'services', title: 'Platform services catalog', description: 'Every service games and agents can use, with SDK calls, MCP tools, limits and guidelines, and what the platform does not provide. JSON.', mimeType: 'application/json' },
        ...PLATFORM_GUIDES.map((g) => ({ uri: `gcp://guides/${g.topic}`, name: g.topic, title: g.title, description: g.summary, mimeType: 'text/markdown' })),
        ...TEMPLATES.map((t) => ({ uri: `gcp://templates/${t.name}`, name: `${t.name}-template`, title: t.title, description: t.description, mimeType: 'image/png' })),
      ] });
    case 'resources/read': {
      if (params?.uri === 'gcp://services') {
        const catalog = { services: platformServices(await getSettings(c.env), c.origin), not_provided: NOT_PROVIDED, discover: DISCOVERY };
        return ok({ contents: [{ uri: 'gcp://services', mimeType: 'application/json', text: JSON.stringify(catalog, null, 1) }] });
      }
      const tm = String(params?.uri || '').match(/^gcp:\/\/templates\/([a-z0-9\-]+)$/), tpl = tm && TEMPLATES.find((t) => t.name === tm[1]);
      if (tpl) {
        const r = await c.env.ASSETS.fetch(new Request('https://assets.local' + tpl.path));
        if (!r.ok) return rpcError(id, -32002, 'Resource not found');
        return ok({ contents: [{ uri: params.uri, mimeType: 'image/png', blob: b64(new Uint8Array(await r.arrayBuffer())) }] });
      }
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
    if (body.length > MAX_BATCH) return Response.json(rpcError(null, -32600, `A batch holds at most ${MAX_BATCH} messages.`), { status: 400, headers: cors });
    const out = (await Promise.all(body.map((m) => dispatch(m, ctx)))).filter(Boolean);
    return out.length ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
  }
  const res = await dispatch(body, ctx);
  return res ? Response.json(res, { headers: cors }) : new Response(null, { status: 202, headers: cors });
}
