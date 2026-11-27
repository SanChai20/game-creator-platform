// Shared pagination parsing and metadata helpers for API endpoints.
// Accepts either ?page=1&per_page=20 or ?offset=0&limit=20 so both numbered pages and offset callers work cleanly.

export interface PageSpec {
  page: number;
  per_page: number;
  offset: number;
  limit: number;
}

const MAX_PAGE = 10_000;
const MAX_OFFSET = 200_000;

export function parsePage(
  query: (key: string) => string | undefined,
  defaultPerPage = 20,
  maxPerPage = 100,
): PageSpec {
  const rawLimit = query('per_page') ?? query('limit');
  const parsedLimit = rawLimit != null && rawLimit !== '' ? Math.floor(Number(rawLimit)) : defaultPerPage;
  const per_page = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(maxPerPage, parsedLimit) : defaultPerPage;

  const rawPage = query('page');
  const rawOffset = query('offset');
  if (rawPage != null && rawPage !== '') {
    const p = Math.floor(Number(rawPage));
    const page = Number.isFinite(p) ? Math.max(1, Math.min(MAX_PAGE, p)) : 1;
    const offset = Math.min(MAX_OFFSET, (page - 1) * per_page);
    return { page, per_page, offset, limit: per_page };
  }
  if (rawOffset != null && rawOffset !== '') {
    const o = Math.floor(Number(rawOffset));
    const offset = Number.isFinite(o) ? Math.max(0, Math.min(MAX_OFFSET, o)) : 0;
    const page = Math.floor(offset / per_page) + 1;
    return { page, per_page, offset, limit: per_page };
  }
  return { page: 1, per_page, offset: 0, limit: per_page };
}

export function pageMeta(total: number, page: number, per_page: number) {
  const safeTotal = Math.max(0, Math.floor(total || 0));
  const pages = Math.max(1, Math.ceil(safeTotal / Math.max(1, per_page)));
  return { total: safeTotal, page, per_page, pages };
}
