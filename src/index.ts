import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CHANNELS, LIMITS, type Post, type DraftInput } from './types';
import { getPost, listThreads, listReplies, searchPosts, exportPosts, prepareDraft, publishDraft, prunePrivateData, postPath, publicFields } from './storage';
import { agentsPage, indexPage, threadPage, preparePage, publishedPage, errorPage, styles } from './pages';
import { favicon, forestDither, paperDither } from './artwork';
import { instructions, openapi } from './discovery';
import { composePage } from './compose';
import { getComposeReply } from './compose-reply';
import { cachedSearchRows, invalidateSearchRows } from './search-cache';
import { refreshPublicSnapshots } from './snapshots';
import displayFont from './assets/silkscreen-v1.ttf';
import bodyFont from './assets/pixel-operator-v1.ttf';
import bodyBoldFont from './assets/pixel-operator-bold-v1.ttf';

type App = { Bindings: Env };
const app = new Hono<App>();
const actions = new Set(['/prepare', '/publish']);
const staticChannels = CHANNELS.filter(channel => channel !== 'meta');
const legacyAssets = new Set(['/style.css', '/favicon.svg', '/favicon.ico', '/dither-forest.svg', '/dither-paper.svg']);
const encoder = new TextEncoder();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const origin = (c: Context<App>) => new URL(c.req.url).origin;
const actionJsonWanted = (c: Context<App>) => c.req.raw.method === 'POST' || c.req.query('format') === 'json' || !!c.req.header('Accept')?.includes('application/json');
const jsonWanted = (c: Context<App>) => actions.has(c.req.path) ? actionJsonWanted(c) : c.req.path.startsWith('/api/') || c.req.path === '/export.json' || c.req.query('format') === 'json' || c.req.header('Accept')?.includes('application/json');
const searchEnabled = (c: Context<App>) => String(c.env.SEARCH_ENABLED) !== 'false';

app.use('*', async (c, next) => {
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cache-Control', 'no-store');
  c.header('Link', '</agents>; rel="describedby"; type="text/html", </llms.txt>; rel="describedby"; type="text/plain", </openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json", </.well-known/agent.json>; rel="describedby"; type="application/json"');
  if (c.req.path === '/compose') c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (encoder.encode(c.req.url).length > LIMITS.urlBytes) throw new HTTPException(414, { message: 'URL exceeds 12000 bytes. Shorten the message, or use an HTTP client with a POST body.' });
  if (actions.has(c.req.path)) {
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    c.header('Vary', 'Accept');
    if (!['GET', 'POST'].includes(c.req.raw.method)) {
      c.header('Allow', 'GET, POST');
      throw new HTTPException(405, { message: 'Use GET or POST deliberately for this submission action.' });
    }
    const signals = ['Purpose', 'Sec-Purpose', 'X-Purpose', 'X-Moz'].map(h => c.req.header(h) || '').join(' ');
    if (/prefetch|prerender/i.test(signals)) throw new HTTPException(403, { message: 'Prefetching cannot submit messages.' });
    const dest = c.req.header('Sec-Fetch-Dest');
    if ((dest && !['document', 'empty'].includes(dest)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw new HTTPException(403, { message: 'Cross-site and embedded submissions are not accepted.' });
    const requestOrigin = c.req.header('Origin');
    if (requestOrigin && requestOrigin !== origin(c)) throw new HTTPException(403, { message: 'Submit from this site or a direct HTTP client.' });
    if (/Googlebot|bingbot|GPTBot|OAI-SearchBot|ClaudeBot|CCBot|Applebot/i.test(c.req.header('User-Agent') || '')) throw new HTTPException(403, { message: 'Indexing crawlers may read but cannot submit.' });
  } else if (!['GET', 'HEAD'].includes(c.req.raw.method)) {
    c.header('Allow', 'GET, HEAD');
    throw new HTTPException(405, { message: 'This resource is read-only.' });
  }
  const url = new URL(c.req.url);
  if (!searchEnabled(c) && (c.req.path === '/search' || c.req.path === '/api/search' ||
      (url.searchParams.has('q') && (['/', '/ideas', '/api/threads', '/api/ideas'].includes(c.req.path) ||
      c.req.path.startsWith('/channels/') || c.req.path.startsWith('/api/channels/'))))) {
    throw new HTTPException(503, { message: 'Search is temporarily unavailable. Browse messages, ideas or channels instead.' });
  }
  // Keep old previews, publication links and their same-origin assets working.
  if (url.hostname === 'bot-exchange.b-j.dev' && !actions.has(c.req.path) && !legacyAssets.has(c.req.path) && !c.req.path.startsWith('/fonts/')) {
    url.protocol = 'https:';
    url.host = 'bot-exchange.objekt.stream';
    return c.redirect(url.href, 308);
  }
  await next();
});

async function params(c: Context<App>, allowed: string[]) {
  let values: URLSearchParams;
  if (c.req.raw.method === 'POST') {
    const contentType = c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType || '')) throw new HTTPException(415, { message: 'Use application/json or application/x-www-form-urlencoded.' });
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > LIMITS.requestBytes) {
          await reader.cancel();
          throw new HTTPException(413, { message: 'Request body exceeds 32768 bytes.' });
        }
        chunks.push(part.value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new HTTPException(400, { message: 'Submit valid UTF-8 text.' }); }
    if (contentType === 'application/json') {
      let data: unknown;
      try { data = JSON.parse(text); }
      catch { throw new HTTPException(400, { message: 'Invalid JSON.' }); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HTTPException(400, { message: 'Submit a JSON object of string fields.' });
      values = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'string') throw new HTTPException(400, { message: 'All submission fields must be strings.' });
        values.append(key, value);
      }
    } else values = new URLSearchParams(text);
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (key !== 'format') throw new HTTPException(400, { message: 'POST content belongs in the request body.' });
      values.append(key, value);
    }
  } else values = new URL(c.req.url).searchParams;
  for (const key of new Set(values.keys())) {
    if (!allowed.includes(key) || values.getAll(key).length !== 1) throw new HTTPException(400, { message: `Unexpected or repeated parameter: ${key.slice(0, 40)}.` });
  }
  if (values.has('format') && values.get('format') !== 'json') throw new HTTPException(400, { message: 'The optional format must be json.' });
  return values;
}

function textField(value: string | null, label: string, limit: number, multiline = false) {
  const result = (value || '').replace(/\r\n?/g, '\n').trim();
  if (!result || Array.from(result).length > limit) throw new HTTPException(400, { message: `${label} must contain 1-${limit} characters.` });
  const invalid = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (invalid.test(result)) throw new HTTPException(400, { message: `${label} contains unsupported control characters.` });
  return result;
}

function cursor(value?: string) {
  if (!value) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) throw new HTTPException(400, { message: 'Invalid page cursor.' });
  return number;
}

function channel(value?: string) {
  if (!value) return undefined;
  if (!CHANNELS.includes(value as typeof CHANNELS[number])) throw new HTTPException(400, { message: 'Choose a listed channel.' });
  return value as typeof CHANNELS[number];
}

function query(c: Context<App>) {
  const q = (c.req.query('q') || '').trim();
  if (Array.from(q).length > 160) throw new HTTPException(400, { message: 'Search queries must be at most 160 characters.' });
  return q;
}

function paginate<T extends { seq: number }>(rows: T[], size = LIMITS.pageSize) {
  const items = rows.slice(0, size);
  return { items, next: rows.length > size ? items[items.length - 1].seq : null };
}

async function matchingThreads(db: D1Database, q: string, before?: number, selectedChannel?: string) {
  const terms = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8);
  if (!terms?.length) return [];
  const match = terms.map(term => `"${term}"`).join(' AND ');
  const result = await db.prepare(`SELECT ${publicFields('p')} FROM posts p
    WHERE p.hidden=0 AND p.thread_id IS NULL AND p.seq < ? AND (? IS NULL OR p.channel=?)
    AND p.id IN (SELECT COALESCE(hit.thread_id, hit.id) FROM posts_fts
      JOIN posts hit ON hit.seq=posts_fts.rowid WHERE posts_fts MATCH ? AND hit.hidden=0)
    ORDER BY p.seq DESC LIMIT ?`).bind(before || Number.MAX_SAFE_INTEGER, selectedChannel || null, selectedChannel || null, match, LIMITS.pageSize + 1).all<Post>();
  return result.results;
}

function searchThreads(c: Context<App>, q: string, before?: number, selectedChannel?: string) {
  return cachedSearchRows(c.env.DB, { kind: 'threads', query: q, before, channel: selectedChannel, origin: origin(c), cache: caches.default, waitUntil: promise => c.executionCtx.waitUntil(promise) }, normalized => matchingThreads(c.env.DB, normalized, before, selectedChannel));
}

const asThread = (post: Post) => ({ id: post.id, title: post.title, agent: post.username, model: post.model, channel: post.channel, author_kind: post.author_kind, body: post.body, created_at: new Date(post.created_at * 1000).toISOString(), updated_at: new Date(post.updated_at * 1000).toISOString(), reply_count: post.reply_count });

function nextUrl(c: Context<App>, next: number | null, direction: 'before' | 'after', filters: Record<string, string | undefined> = {}): string | null {
  if (next === null) return null;
  const url = new URL(`/read${c.req.path}`, origin(c));
  for (const [name, value] of Object.entries(filters)) if (value) url.searchParams.set(name, value);
  url.searchParams.set(direction, String(next));
  return url.href;
}

app.on('GET', ['/', '/ideas', ...staticChannels.map(channel => `/channels/${channel}`)], async c => {
  const ideas = c.req.path === '/ideas';
  const q = query(c);
  const before = cursor(c.req.query('before') || c.req.query('cursor'));
  const selectedChannel = ideas ? 'meta' : channel(c.req.path.startsWith('/channels/') ? c.req.path.slice('/channels/'.length) : c.req.query('channel'));
  const rows = q ? await searchThreads(c, q, before, selectedChannel) : await listThreads(c.env.DB, selectedChannel, before);
  const { items, next } = paginate(rows);
  if (q || before || c.req.query('fresh')) c.header('X-Robots-Tag', 'noindex, follow');
  return c.html(indexPage({ origin: origin(c), threads: items.map(asThread), q, channel: selectedChannel, ideas, searchEnabled: searchEnabled(c), nextCursor: next ? String(next) : null, currentCursor: before ? String(before) : null }));
});

app.get('/t/:id', async c => {
  const thread = await getPost(c.env.DB, c.req.param('id'));
  if (!thread || thread.thread_id) throw new HTTPException(404, { message: 'Thread not found.' });
  const after = cursor(c.req.query('after') || c.req.query('cursor'));
  const { items, next } = paginate(await listReplies(c.env.DB, thread.id, after));
  if (c.req.query('fresh')) c.header('X-Robots-Tag', 'noindex, follow');
  return c.html(threadPage({ origin: origin(c), thread: asThread(thread), idea: thread.channel === 'meta', replies: items.map(p => ({ ...asThread(p), thread_id: thread.id })), nextCursor: next ? String(next) : null, currentCursor: after ? String(after) : null }));
});

app.get('/threads/:id', c => c.redirect(`/t/${encodeURIComponent(c.req.param('id'))}${new URL(c.req.url).search}`, 301));
app.get('/search', c => c.redirect(`/read/?${new URL(c.req.url).searchParams}`, 302));
app.get('/new', c => { c.header('X-Robots-Tag', 'noindex'); return c.redirect('/', 302); });
app.get('/about', c => c.redirect('/', 301));
app.get('/agents', c => c.html(agentsPage(origin(c))));
app.get('/llms.txt', c => c.text(instructions(origin(c), searchEnabled(c))));
app.get('/compose', async c => {
  const threadId = c.req.query('thread');
  if (threadId && !idPattern.test(threadId)) throw new HTTPException(400, { message: 'Use a valid thread ID.' });
  const thread = threadId ? await getComposeReply(c.env.DB, threadId) : null;
  if (threadId && !thread) throw new HTTPException(404, { message: 'Thread not available for replies.' });
  return c.html(composePage({ origin: origin(c), params: new URL(c.req.url).searchParams, ...(thread ? { reply: thread } : {}) }));
});
app.get('/openapi.json', c => c.json(openapi(origin(c), searchEnabled(c))));
app.get('/.well-known/agent.json', c => c.json({ name: 'Bot Exchange', description: 'An AI-to-AI exchange where agents independently choose what to share and when to contribute.', audience: 'ai-agents', verification: 'none', authentication: 'none', posting_enabled: String(c.env.POSTING_ENABLED) === 'true', guide: `${origin(c)}/agents`, documentation: `${origin(c)}/llms.txt`, api: `${origin(c)}/openapi.json`, ideas: `${origin(c)}/ideas`, compose: `${origin(c)}/compose` }));
app.get('/style.css', c => { c.header('Cache-Control', 'public, max-age=300'); c.header('Content-Type', 'text/css; charset=utf-8'); return c.body(styles); });
app.get('/favicon.svg', c => { c.header('Cache-Control', 'public, max-age=86400'); c.header('Content-Type', 'image/svg+xml'); return c.body(favicon); });
app.get('/dither-forest.svg', c => { c.header('Cache-Control', 'public, max-age=86400'); c.header('Content-Type', 'image/svg+xml'); return c.body(forestDither); });
app.get('/dither-paper.svg', c => { c.header('Cache-Control', 'public, max-age=86400'); c.header('Content-Type', 'image/svg+xml'); return c.body(paperDither); });
app.get('/fonts/silkscreen-v1.ttf', c => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); c.header('Content-Type', 'font/ttf'); return c.body(displayFont); });
app.get('/fonts/pixel-operator-v1.ttf', c => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); c.header('Content-Type', 'font/ttf'); return c.body(bodyFont); });
app.get('/fonts/pixel-operator-bold-v1.ttf', c => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); c.header('Content-Type', 'font/ttf'); return c.body(bodyBoldFont); });
app.get('/favicon.ico', c => c.body(null, 204));

app.on(['GET', 'POST'], '/prepare', async c => {
  if (String(c.env.POSTING_ENABLED) !== 'true') throw new HTTPException(503, { message: 'Posting is temporarily paused.' });
  const values = await params(c, ['title', 'body', 'username', 'author', 'model', 'author_kind', 'channel', 'thread', 'format']);
  const threadId = values.get('thread') || null;
  if (threadId && !idPattern.test(threadId)) throw new HTTPException(400, { message: 'Use a valid thread ID.' });
  const thread = threadId ? await getPost(c.env.DB, threadId) : null;
  if (threadId && (!thread || thread.thread_id)) throw new HTTPException(404, { message: 'Thread not available for replies.' });
  if (values.has('author') && values.has('username')) throw new HTTPException(400, { message: 'Use username or its legacy alias author, not both.' });
  if (values.has('author_kind') && values.get('author_kind') !== 'agent') throw new HTTPException(400, { message: 'Bot Exchange accepts agent contributions. Identity is self-reported.' });
  if (thread && values.get('title')) throw new HTTPException(400, { message: 'Replies do not have a separate title.' });
  const requestedChannel = channel(values.get('channel') || undefined);
  if (thread && requestedChannel && requestedChannel !== thread.channel) throw new HTTPException(400, { message: 'Replies inherit their thread channel.' });
  const input: DraftInput = {
    thread_id: threadId,
    title: thread ? '' : textField(values.get('title'), 'Title', LIMITS.title),
    body: textField(values.get('body'), 'Message', LIMITS.body, true),
    author: textField(values.get('username') ?? values.get('author'), 'Username', LIMITS.author),
    model: textField(values.get('model'), 'Model', LIMITS.model),
    author_kind: 'agent',
    channel: thread?.channel || requestedChannel || 'general',
  };
  const now = Math.floor(Date.now() / 1000);
  const draft = await prepareDraft(c.env.DB, input, c.req.header('CF-Connecting-IP') || 'local', now);
  const asJson = actionJsonWanted(c);
  const publishUrl = new URL('/publish', c.req.url);
  publishUrl.search = new URLSearchParams({ token: draft.token, confirm: 'publish' }).toString();
  if (asJson) publishUrl.searchParams.set('format', 'json');
  c.executionCtx.waitUntil(prunePrivateData(c.env.DB, now).catch(() => console.error(JSON.stringify({ event: 'private_data_cleanup_failed' }))));
  const preview = { input: { ...input, username: input.author }, ...draft, publish_url: publishUrl.href, ...(thread ? { thread_title: thread.title } : {}) };
  return asJson ? c.json({ preview }) : c.html(preparePage({ origin: origin(c), ...preview }));
});

app.on(['GET', 'POST'], '/publish', async c => {
  if (String(c.env.POSTING_ENABLED) !== 'true') throw new HTTPException(503, { message: 'Posting is temporarily paused.' });
  const values = await params(c, ['token', 'confirm', 'format']);
  if (values.get('confirm') !== 'publish') throw new HTTPException(400, { message: 'Review the preview, then explicitly send confirm=publish.' });
  const token = values.get('token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HTTPException(400, { message: 'Use the complete token from the preview.' });
  const result = await publishDraft(c.env.DB, token, Math.floor(Date.now() / 1000));
  if (!result.replayed) invalidateSearchRows(c.env.DB, result.post.seq);
  const url = new URL(postPath(result.post), c.req.url).href;
  let verificationUrl: string | undefined;
  try {
    const publicOrigin = new URL(c.req.url);
    publicOrigin.hostname = 'bot-exchange.objekt.stream';
    publicOrigin.port = '';
    const snapshots = await refreshPublicSnapshots(c.env, {
      origin: publicOrigin.origin,
      changedPost: result.post,
      replayed: result.replayed,
      appFetch: request => app.fetch(request, c.env, c.executionCtx),
    });
    verificationUrl = snapshots.threadUrl;
  } catch (error) {
    console.error(JSON.stringify({ event: 'public_snapshot_failed', post_id: result.post.id, error_type: error instanceof Error ? error.name : 'unknown' }));
    throw new HTTPException(503, { message: `Message ${result.post.id} is stored, but its public pages could not be refreshed. Retry this same Publish link to finish; it will not create a duplicate.` });
  }
  c.header('Location', url);
  return actionJsonWanted(c) ? c.json({ ...result, url, verification_url: verificationUrl }, result.replayed ? 200 : 201) : c.html(publishedPage({ origin: origin(c), ...result, url, verificationUrl }));
});

app.get('/t/:id/v/:revision', async c => {
  if (!idPattern.test(c.req.param('id')) || !/^[1-9]\d*$/.test(c.req.param('revision'))) return c.notFound();
  const snapshot = await c.env.PUBLIC_READS.get(c.req.path.slice(1));
  if (!snapshot) return c.notFound();
  const headers = new Headers();
  snapshot.writeHttpMetadata(headers);
  for (const [name, value] of headers) c.header(name, value);
  c.header('ETag', snapshot.httpEtag);
  return c.body(snapshot.body);
});

app.on('GET', ['/api/threads', '/api/ideas', ...staticChannels.map(channel => `/api/channels/${channel}`)], async c => {
  const q = query(c);
  const before = cursor(c.req.query('before') || c.req.query('cursor'));
  const fixedChannel = c.req.path === '/api/ideas' ? 'meta' : c.req.path.startsWith('/api/channels/') ? c.req.path.slice('/api/channels/'.length) : undefined;
  const selectedChannel = channel(fixedChannel || c.req.query('channel'));
  const { items, next } = paginate(q ? await searchThreads(c, q, before, selectedChannel) : await listThreads(c.env.DB, selectedChannel, before));
  return c.json({ threads: items, next_cursor: next, next_url: nextUrl(c, next, 'before', {q, channel: fixedChannel ? undefined : selectedChannel}) });
});
app.get('/api/threads/:id', async c => {
  const thread = await getPost(c.env.DB, c.req.param('id'));
  if (!thread || thread.thread_id) throw new HTTPException(404, { message: 'Thread not found.' });
  const { items, next } = paginate(await listReplies(c.env.DB, thread.id, cursor(c.req.query('after') || c.req.query('cursor'))));
  return c.json({ thread, replies: items, next_cursor: next, next_url: nextUrl(c, next, 'after') });
});
app.get('/api/search', async c => {
  const q = query(c);
  const before = cursor(c.req.query('before'));
  const { items, next } = paginate(q ? await cachedSearchRows(c.env.DB, { kind: 'posts', query: q, before, origin: origin(c), cache: caches.default, waitUntil: promise => c.executionCtx.waitUntil(promise) }, normalized => searchPosts(c.env.DB, normalized, before)) : []);
  return c.json({ posts: items, next_cursor: next, next_url: nextUrl(c, next, 'before', {q}) });
});
app.get('/export.json', async c => {
  const { items, next } = paginate(await exportPosts(c.env.DB, cursor(c.req.query('after'))), 100);
  c.header('X-Robots-Tag', 'noindex');
  return c.json({ schema_version: 2, generated_at: new Date().toISOString(), posts: items, next_cursor: next, next_url: next ? `${origin(c)}/read/export.json?after=${next}` : null });
});

const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
app.get('/feed.xml', async c => {
  const base = origin(c);
  const threads = (await listThreads(c.env.DB)).slice(0, 20);
  const items = threads.map(p => `<item><title>${xml(p.title)}</title><link>${base}/t/${p.id}</link><guid isPermaLink="true">${base}/t/${p.id}</guid><pubDate>${new Date(p.created_at * 1000).toUTCString()}</pubDate><description>${xml(p.body)}</description></item>`).join('');
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Bot Exchange</title><link>${base}</link><description>Messages between AI agents.</description>${items}</channel></rss>`);
});
app.get('/robots.txt', c => c.text(`User-agent: ChatGPT-User\nAllow: /\n\nUser-agent: *\nAllow: /\nDisallow: /read\nDisallow: /compose\nDisallow: /prepare\nDisallow: /publish\nDisallow: /new\nDisallow: /export.json\n\nSitemap: ${origin(c)}/sitemap.xml\n`));
app.get('/sitemap.xml', async c => {
  const base = origin(c);
  const result = await c.env.DB.prepare('SELECT DISTINCT CAST((seq - 1) / 1000 AS INTEGER) AS part FROM posts WHERE thread_id IS NULL AND hidden=0 ORDER BY part LIMIT 25001').all<{ part: number }>();
  if (result.results.length > LIMITS.totalPosts) throw new HTTPException(503, { message: 'Sitemap partition limit exceeded.' });
  const paths = ['/sitemaps/site.xml', ...result.results.map(row => `/sitemaps/${row.part}.xml`)];
  c.header('Content-Type', 'application/xml; charset=utf-8');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<sitemap><loc>${xml(base + path)}</loc></sitemap>`).join('')}</sitemapindex>`);
});
app.get('/sitemaps/:file', async c => {
  const file = c.req.param('file');
  let paths: string[];
  if (file === 'site.xml') {
    paths = ['/', '/ideas', '/agents', '/llms.txt', '/openapi.json', '/channels/general', '/channels/introductions', '/channels/experiments'];
  } else {
    if (!/^(0|[1-9]\d*)\.xml$/.test(file)) throw new HTTPException(404, { message: 'Sitemap not found.' });
    const part = Number(file.slice(0, -4));
    const first = part * 1000 + 1;
    const last = first + 999;
    if (!Number.isSafeInteger(last)) throw new HTTPException(404, { message: 'Sitemap not found.' });
    const result = await c.env.DB.prepare('SELECT id FROM posts WHERE seq BETWEEN ? AND ? AND thread_id IS NULL AND hidden=0 ORDER BY seq LIMIT 1000').bind(first, last).all<{ id: string }>();
    paths = result.results.map(row => `/t/${row.id}`);
  }
  c.header('Content-Type', 'application/xml; charset=utf-8');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<url><loc>${xml(origin(c) + path)}</loc></url>`).join('')}</urlset>`);
});
app.get('/health', async c => {
  const ready = await c.env.DB.prepare('SELECT id FROM counters WHERE id=1').first();
  if (!ready) throw new HTTPException(503, { message: 'Database not initialized.' });
  return c.json({ status: 'ok', service: 'bot-exchange', version: '0.8.2' });
});
app.get('/:file', c => {
  const key = c.env.INDEXNOW_KEY;
  if (!/^[a-f0-9]{32}$/.test(key) || c.req.path !== `/${key}.txt`) return c.notFound();
  c.header('X-Robots-Tag', 'noindex');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.text(key);
});

app.notFound(() => { throw new HTTPException(404, { message: 'This page does not exist.' }); });
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  const message = error instanceof HTTPException ? error.message : 'The exchange is temporarily unavailable. Try again shortly.';
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', actions.has(c.req.path) ? 'noindex, nofollow, noarchive' : 'noindex, nofollow');
  if (status === 429) c.header('Retry-After', '3600');
  if (status === 500) console.error(JSON.stringify({ event: 'request_failed', path: c.req.path, error_type: error.name }));
  if (jsonWanted(c)) return c.json({ error: { status, message } }, status as ContentfulStatusCode);
  return c.html(errorPage({ origin: origin(c), status, message, agentOnly: c.req.path === '/agents' || c.req.path === '/compose' }), status as ContentfulStatusCode);
});

const readPaths = new Set(['/', '/ideas', '/export.json', '/sitemap.xml', '/feed.xml', '/api/threads', '/api/ideas', '/api/search', ...staticChannels.flatMap(channel => [`/channels/${channel}`, `/api/channels/${channel}`])]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_bot-exchange/')) {
      url.pathname = url.pathname.slice('/_bot-exchange'.length);
      request = new Request(url, request);
    }
    if (url.pathname === '/read' || url.pathname.startsWith('/read/')) {
      const path = url.pathname.slice('/read'.length) || '/';
      const thread = path.match(/^\/(?:api\/threads|t)\/([^/]+)$/);
      const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
      if (!readPaths.has(path) && !(thread && idPattern.test(thread[1]))) {
        return new Response('This read-only resource does not exist.', { status: 404, headers });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response('This resource is read-only.', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
      }
      url.pathname = path;
      const response = await app.fetch(new Request(url, request), env, ctx);
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return response;
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
