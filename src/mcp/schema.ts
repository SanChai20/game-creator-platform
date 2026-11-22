// What tools/list and tools/call hold every tool to: the annotations an MCP client reads, and the check of a call's
// arguments against the tool's input schema. No Worker imports, so tests/mcp-server.mjs runs it as it is.
export interface ListedTool { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }
type Schema = { properties?: Record<string, any>; required?: string[] };

const TYPE_OK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray, integer: (v) => Number.isInteger(typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  number: (v) => Number.isFinite(typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
};
/** Holds a call to its tool's input schema: unknown arguments and arguments of the wrong type are refused with the schema. */
export function checkArgs(schema: Schema, args: Record<string, unknown>): string | null {
  const props = schema.properties || {};
  // own keys only: "constructor" or "toString" are not arguments of any tool
  const unknown = Object.keys(args).filter((k) => !Object.hasOwn(props, k));
  if (unknown.length) return `Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. This tool accepts: ${Object.keys(props).join(', ') || 'no arguments'}.`;
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue;
    const types = ([] as string[]).concat(props[k]?.type || []);
    if (types.length && !types.some((t) => TYPE_OK[t]?.(v) ?? true)) return `${k} must be ${types.join(' or ')}.`;
    if (props[k]?.enum && !props[k].enum.includes(v)) return `${k} must be one of: ${props[k].enum.join(', ')}.`;
  }
  return null;
}

// Names models and clients use for the project argument when they do not read the schema closely.
const PROJECT_ALIASES = ['project_id', 'projectId', 'project_slug', 'slug'];
// Wrappers some clients and smaller models put around the arguments object.
const WRAPPERS = ['arguments', 'args', 'input', 'params', 'parameters'];

/**
 * The arguments as the tool means them, from what clients and models actually send: a JSON string instead of an object,
 * the object wrapped once more ({arguments: {...}}), project_id for project, "true" for true, "3" for 3, and an array or
 * object sent as a JSON string. Only unambiguous repairs: anything else is left for checkArgs to explain.
 */
export function normalizeArgs(schema: Schema, raw: unknown): Record<string, unknown> {
  const props = schema.properties || {};
  let args: unknown = raw;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* left as it is: refused below */ } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  let a = { ...(args as Record<string, unknown>) };
  const keys = Object.keys(a);
  if (keys.length === 1 && WRAPPERS.includes(keys[0]) && !Object.hasOwn(props, keys[0])) {
    let inner = a[keys[0]];
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* not JSON */ } }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) a = { ...(inner as Record<string, unknown>) };
  }
  if (Object.hasOwn(props, 'project') && a.project === undefined) {
    const alias = PROJECT_ALIASES.find((k) => !Object.hasOwn(props, k) && typeof a[k] === 'string');
    if (alias) { a.project = a[alias]; delete a[alias]; }
  }
  for (const [k, v] of Object.entries(a)) {
    if (!Object.hasOwn(props, k) || typeof v !== 'string') continue;
    const types = ([] as string[]).concat(props[k]?.type || []);
    if (!types.length || types.includes('string')) continue;
    const s = v.trim();
    if (types.includes('boolean') && /^(true|false)$/i.test(s)) a[k] = s.toLowerCase() === 'true';
    else if ((types.includes('integer') || types.includes('number')) && s !== '' && Number.isFinite(Number(s))) a[k] = Number(s);
    else if ((types.includes('array') && s.startsWith('[')) || (types.includes('object') && s.startsWith('{'))) {
      try { const j = JSON.parse(s); if (types.some((t) => TYPE_OK[t]?.(j))) a[k] = j; } catch { /* left for checkArgs */ }
    }
  }
  return a;
}

/**
 * A tool's arguments in a few lines, for an answer that refuses a call: names, types, allowed values and which are required.
 * Short on purpose: the whole schema of a big tool is thousands of characters, too much to repeat in every refusal.
 */
export function signature(schema: Schema): string {
  const props = schema.properties || {}, req = new Set(schema.required || []);
  const one = ([k, p]: [string, any]) => {
    const types = ([] as string[]).concat(p?.type || 'any').join(' | ');
    const allowed = Array.isArray(p?.enum) ? ` (${p.enum.slice(0, 8).map((x: unknown) => JSON.stringify(x)).join(', ')}${p.enum.length > 8 ? ', …' : ''})` : '';
    return `${k}${req.has(k) ? '' : '?'}: ${types}${allowed}`;
  };
  return `Arguments: {${Object.entries(props).map(one).join(', ')}} (? = optional). tools/list has each one's description.`;
}

/** A tool as tools/list shows it. A read-only tool is idempotent; any other tool says so itself (annotations.idempotentHint). */
export const listed = (t: ListedTool) => {
  const ro = !!t.annotations?.readOnlyHint;
  return {
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: ro, destructiveHint: !ro && !!t.annotations?.destructiveHint, idempotentHint: ro || !!t.annotations?.idempotentHint, openWorldHint: false },
  };
};
