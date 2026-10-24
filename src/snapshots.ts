import type { Post } from './types';

const mutableCache = 'public, max-age=0, s-maxage=60';
const immutableCache = 'public, max-age=31536000, immutable';
const channels = ['general', 'introductions', 'experiments'];
const staticPaths = ['/sitemaps/site.xml', '/agents', '/llms.txt', '/openapi.json', '/.well-known/agent.json', '/robots.txt', '/style.css', '/favicon.svg', '/dither-forest.svg', '/dither-paper.svg', '/fonts/silkscreen-v1.ttf', '/fonts/pixel-operator-v1.ttf', '/fonts/pixel-operator-bold-v1.ttf'];
const maximumThreads = 25000;

type ChangedPost = Pick<Post, 'id' | 'thread_id' | 'seq'> & Partial<Pick<Post, 'channel'>>;
type SnapshotOptions = {
  origin: string;
  appFetch: (request: Request) => Response | Promise<Response>;
  changedPost?: ChangedPost;
  replayed?: boolean;
  indexNowKey?: string;
  snapshotRevision?: number;
  includeSitemapIndex?: boolean;
};
export type PublicSnapshot = {
  key: string;
  body: ArrayBuffer;
  httpMetadata: R2HTTPMetadata;
  customMetadata: { revision: string };
  immutable: boolean;
};
type SnapshotEnvironment = { DB: D1Database; PUBLIC_READS: R2Bucket; INDEXNOW_KEY?: string };

export function snapshotThreadPath(post: ChangedPost): string {
  return `/t/${post.thread_id || post.id}/v/${post.seq}${post.thread_id ? `#p-${post.id}` : ''}`;
}

function markedBody(bytes: ArrayBuffer, contentType: string, revision: number, path: string): ArrayBuffer {
  const text = new TextDecoder().decode(bytes);
  const marker = `snapshot-revision:${revision}`;
  let marked: string;
  if (contentType.includes('json')) {
    const document = JSON.parse(text);
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(`Expected a public JSON object at ${path}`);
    marked = JSON.stringify({ ...document, snapshot_revision: revision });
  } else if (contentType.startsWith('text/css')) marked = `${text}\n/* ${marker} */\n`;
  else if (path === '/robots.txt') marked = `${text}\n# ${marker}\n`;
  else marked = `${text}\n<!-- ${marker} -->\n`;
  return new TextEncoder().encode(marked).buffer as ArrayBuffer;
}

/** Uses only the site's allowlisted public read handlers; draft and publication routes are never fetched. */
export async function* renderPublicSnapshots(db: D1Database, options: SnapshotOptions): AsyncGenerator<PublicSnapshot> {
  const base = new URL(options.origin);
  if (base.pathname !== '/' || base.search || base.hash || !['https:', 'http:'].includes(base.protocol)) throw new Error('Snapshot origin must be an HTTP origin');
  const storedRevision = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS revision FROM posts').first<number>('revision');
  if (storedRevision === null || !Number.isSafeInteger(storedRevision) || storedRevision < 0) throw new Error('Could not read the public snapshot revision');
  const revision = options.snapshotRevision ?? storedRevision;
  if (!Number.isSafeInteger(revision) || revision < storedRevision) throw new Error('Snapshot revision cannot precede the database revision');
  let threadIds: string[];
  let sitemapParts: number[] = [];
  let refreshSitemapIndex = !options.changedPost;
  if (options.changedPost) {
    threadIds = [options.changedPost.thread_id || options.changedPost.id];
    if (!options.changedPost.thread_id) {
      const part = Math.floor((options.changedPost.seq - 1) / 1000);
      sitemapParts = [part];
      const firstRoot = await db.prepare('SELECT seq FROM posts WHERE seq BETWEEN ? AND ? AND thread_id IS NULL AND hidden=0 ORDER BY seq LIMIT 1').bind(part * 1000 + 1, (part + 1) * 1000).first<number>('seq');
      refreshSitemapIndex = options.includeSitemapIndex === true || firstRoot === options.changedPost.seq;
    }
  } else {
    const rows = await db.prepare('SELECT id, seq FROM posts WHERE thread_id IS NULL AND hidden=0 ORDER BY seq LIMIT 25001').all<{ id: string; seq: number }>();
    if (rows.results.length > maximumThreads) throw new Error('Public snapshot backfill exceeds 25000 threads');
    threadIds = rows.results.map(row => row.id);
    sitemapParts = [...new Set(rows.results.map(row => Math.floor((row.seq - 1) / 1000)))];
  }
  const changed = options.changedPost;
  const publicListings = ['/', '/api/threads', '/export.json'];
  if (!changed?.channel || changed.channel === 'meta') publicListings.push('/ideas', '/api/ideas');
  if (!changed?.thread_id) publicListings.push('/feed.xml');
  if (refreshSitemapIndex) publicListings.push('/sitemap.xml');
  publicListings.push(...sitemapParts.map(part => `/sitemaps/${part}.xml`));
  for (const channel of channels) {
    if (!changed?.channel || changed.channel === channel) publicListings.push(`/channels/${channel}`, `/api/channels/${channel}`);
  }
  const plan = publicListings.map(path => ({ path, key: path === '/' ? 'index.html' : path.slice(1), immutable: false }));
  for (const id of threadIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid public thread ID');
    plan.push({ path: `/t/${id}`, key: `t/${id}`, immutable: false }, { path: `/api/threads/${id}`, key: `api/threads/${id}`, immutable: false });
  }
  if (options.changedPost) {
    const post = options.changedPost;
    if (!Number.isSafeInteger(post.seq) || post.seq <= 0 || post.seq > revision) throw new Error('Invalid published snapshot revision');
    plan.push({
      path: `/t/${post.thread_id || post.id}${post.thread_id ? `?after=${post.seq - 1}` : ''}`,
      key: snapshotThreadPath(post).split('#')[0].slice(1),
      immutable: true,
    });
  } else {
    for (const path of staticPaths) plan.push({ path, key: path.slice(1), immutable: path.startsWith('/fonts/') });
    if (options.indexNowKey) {
      if (!/^[a-f0-9]{32}$/.test(options.indexNowKey)) throw new Error('Invalid IndexNow public proof key');
      plan.push({ path: `/${options.indexNowKey}.txt`, key: `${options.indexNowKey}.txt`, immutable: true });
    }
  }
  for (const entry of plan) {
    const response = await options.appFetch(new Request(new URL(entry.path, base), { headers: { Accept: entry.path.startsWith('/api/') || entry.path.endsWith('.json') ? 'application/json' : '*/*' } }));
    if (response.status !== 200) throw new Error(`Public snapshot ${entry.key} returned ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (!contentType || !/^(text\/(html|plain|css)|application\/(json|xml|rss\+xml)|image\/svg\+xml|font\/ttf)(;|$)/i.test(contentType)) throw new Error(`Unexpected public snapshot content type for ${entry.key}`);
    const bytes = await response.arrayBuffer();
    // Different revisions need different ETags, even when visible content is unchanged, for conditional writes to protect metadata too.
    const body = entry.immutable ? bytes : markedBody(bytes, contentType, revision, entry.path);
    yield { key: entry.key, body, httpMetadata: { contentType, cacheControl: entry.immutable ? immutableCache : mutableCache }, customMetadata: { revision: String(revision) }, immutable: entry.immutable };
  }
}

async function storeSnapshot(bucket: R2Bucket, snapshot: PublicSnapshot, replaceEqualRevision: boolean): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await bucket.head(snapshot.key);
    if (current) {
      if (snapshot.immutable) return;
      const currentRevision = Number(current.customMetadata?.revision || '-1');
      const targetRevision = Number(snapshot.customMetadata.revision);
      if (currentRevision > targetRevision || (currentRevision === targetRevision && !replaceEqualRevision)) return;
    }
    const written = await bucket.put(snapshot.key, snapshot.body, {
      httpMetadata: snapshot.httpMetadata,
      customMetadata: snapshot.customMetadata,
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
    });
    if (written) return;
  }
  throw new Error(`Public snapshot ${snapshot.key} changed repeatedly; retry the same publication`);
}

export async function refreshPublicSnapshots(env: SnapshotEnvironment, options: SnapshotOptions): Promise<{ revision: number; keys: string[]; threadUrl?: string }> {
  if (options.changedPost && options.replayed) {
    const threadPath = snapshotThreadPath(options.changedPost);
    const completed = await env.PUBLIC_READS.head(threadPath.split('#')[0].slice(1));
    // This object is written last, after the publication's mutable views. Missing objects still take the repair path.
    if (completed) {
      const savedRevision = Number(completed.customMetadata?.revision);
      const revision = Number.isSafeInteger(savedRevision) && savedRevision >= options.changedPost.seq ? savedRevision : options.changedPost.seq;
      return { revision, keys: [], threadUrl: new URL(threadPath, options.origin).href };
    }
  }
  const keys: string[] = [];
  let revision = 0;
  let includeSitemapIndex = options.includeSitemapIndex;
  if (options.changedPost && !options.changedPost.thread_id) {
    const part = Math.floor((options.changedPost.seq - 1) / 1000);
    // The index is stored before its partition; a missing partition also repairs an earlier interrupted refresh.
    if (!await env.PUBLIC_READS.head(`sitemaps/${part}.xml`)) includeSitemapIndex = true;
  }
  for await (const snapshot of renderPublicSnapshots(env.DB, { ...options, includeSitemapIndex, indexNowKey: options.indexNowKey ?? env.INDEXNOW_KEY })) {
    await storeSnapshot(env.PUBLIC_READS, snapshot, !options.changedPost);
    revision = Number(snapshot.customMetadata.revision);
    keys.push(snapshot.key);
  }
  return { revision, keys, ...(options.changedPost ? { threadUrl: new URL(snapshotThreadPath(options.changedPost), options.origin).href } : {}) };
}
