import { HTTPException } from 'hono/http-exception';

const ttlMilliseconds = 30_000;
const maximumEntries = 128;
const maximumRows = 21;
const states = new WeakMap<D1Database, SearchState>();

type Entry = { rows: unknown[]; expiresAt: number };
type SearchState = { revision: number; entries: Map<string, Entry>; inflight: Map<string, Promise<unknown[]>> };
type SearchOptions = {
  kind: 'threads' | 'posts';
  query: string;
  before?: number;
  channel?: string;
  origin: string;
  cache?: Pick<Cache, 'match' | 'put'>;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
};

export function normalizeSearchQuery(query: string): string {
  const text = query.trim();
  if (Array.from(text).length > 160) throw new HTTPException(400, { message: 'Search queries must be at most 160 characters.' });
  // Keep the existing first-eight-token AND search; reorder/deduplicate equivalent queries without interpreting FTS operators.
  const terms = (text.match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 8).map(term => term.replace(/[A-Z]/g, letter => letter.toLowerCase()));
  return [...new Set(terms)].sort().join(' ');
}

/** Invalidate this isolate after publication; other isolates retain their results for at most 30 seconds. */
export function invalidateSearchRows(db: D1Database, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('Invalid search revision');
  if ((states.get(db)?.revision ?? 0) >= revision) return;
  // Replacing the state also isolates searches already in flight from the new generation.
  states.set(db, { revision, entries: new Map(), inflight: new Map() });
}

function remember(state: SearchState, key: string, entry: Entry) {
  state.entries.delete(key);
  state.entries.set(key, entry);
  if (state.entries.size > maximumEntries) state.entries.delete(state.entries.keys().next().value!);
}

async function cacheRequest(origin: string, key: string): Promise<Request> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return new Request(new URL(`/.search-cache/v1/${hash}`, origin));
}

/** Search results may lag publication by 30 seconds. This reduces D1 reads, not Worker invocations. */
export async function cachedSearchRows<T>(db: D1Database, options: SearchOptions, load: (query: string) => Promise<T[]>): Promise<T[]> {
  const query = normalizeSearchQuery(options.query);
  if (!query) return [];
  if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before <= 0)) throw new HTTPException(400, { message: 'Invalid page cursor.' });
  const now = options.now || Date.now;
  let state = states.get(db);
  if (!state) { state = { revision: 0, entries: new Map(), inflight: new Map() }; states.set(db, state); }
  const key = JSON.stringify([new URL(options.origin).origin, state.revision, options.kind, query, options.before ?? null, options.channel ?? null]);
  const cached = state.entries.get(key);
  if (cached && cached.expiresAt > now()) {
    remember(state, key, cached);
    return structuredClone(cached.rows) as T[];
  }
  state.entries.delete(key);
  const pending = state.inflight.get(key);
  if (pending) return structuredClone(await pending) as T[];

  const currentState = state;
  const operation = (async (): Promise<T[]> => {
    let request: Request | undefined;
    if (options.cache) {
      request = await cacheRequest(options.origin, key);
      try {
        const response = await options.cache.match(request);
        if (response?.status === 200) {
          const entry = await response.json<Entry>();
          if (Number.isFinite(entry.expiresAt) && entry.expiresAt > now() && entry.expiresAt <= now() + ttlMilliseconds && Array.isArray(entry.rows) && entry.rows.length <= maximumRows) {
            remember(currentState, key, entry);
            return entry.rows as T[];
          }
        }
      } catch { /* An unavailable cache must not disable search. */ }
    }
    const rows = await load(query);
    if (rows.length > maximumRows) throw new Error('Search loader exceeded its bounded result page');
    const entry: Entry = { rows, expiresAt: now() + ttlMilliseconds };
    remember(currentState, key, entry);
    if (options.cache && request) {
      const response = Response.json(entry, { headers: { 'Cache-Control': 'public, max-age=30' } });
      const write = options.cache.put(request, response).catch(() => undefined);
      if (options.waitUntil) options.waitUntil(write);
      else await write;
    }
    return rows;
  })();
  // Overflow requests still work, but cannot grow the promise registry without bound.
  const tracked = currentState.inflight.size < maximumEntries;
  if (tracked) currentState.inflight.set(key, operation);
  try { return structuredClone(await operation); }
  finally { if (tracked && currentState.inflight.get(key) === operation) currentState.inflight.delete(key); }
}
