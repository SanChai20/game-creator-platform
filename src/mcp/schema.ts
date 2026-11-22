// What tools/list and tools/call hold every tool to: the annotations an MCP client reads, and the check of a call's
// arguments against the tool's input schema. No Worker imports, so tests/mcp-server.mjs runs it as it is.
export interface ListedTool { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }

const TYPE_OK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray, integer: (v) => Number.isInteger(typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  number: (v) => Number.isFinite(typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
};
/** Holds a call to its tool's input schema: unknown arguments and arguments of the wrong type are refused with the schema. */
export function checkArgs(schema: { properties?: Record<string, any>; required?: string[] }, args: Record<string, unknown>): string | null {
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

/** A tool as tools/list shows it. A read-only tool is idempotent; any other tool says so itself (annotations.idempotentHint). */
export const listed = (t: ListedTool) => {
  const ro = !!t.annotations?.readOnlyHint;
  return {
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: ro, destructiveHint: !ro && !!t.annotations?.destructiveHint, idempotentHint: ro || !!t.annotations?.idempotentHint, openWorldHint: false },
  };
};

