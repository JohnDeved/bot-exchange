import { HTTPException } from 'hono/http-exception';
import { LIMITS, type Channel, type DraftInput, type Post, type SearchPost } from './types';

const fields = ['seq', 'id', 'thread_id', 'title', 'body', 'author', 'author_kind', 'channel', 'created_at', 'reply_count', 'updated_at', 'model'];

export const publicFields = (alias = ''): string => `${fields.map((field) => `${alias ? `${alias}.` : ''}${field}`).join(', ')}, ${alias ? `${alias}.` : ''}author AS username`;
export const visible = '(p.hidden = 0 AND (p.thread_id IS NULL OR EXISTS (SELECT 1 FROM posts root WHERE root.id = p.thread_id AND root.hidden = 0)))';

async function hash(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getPost(db: D1Database, id: string): Promise<Post | null> {
  return db.prepare(`SELECT ${publicFields('p')} FROM posts p WHERE p.id = ? AND ${visible}`).bind(id).first<Post>();
}

export async function listThreads(db: D1Database, channel?: Channel, before?: number): Promise<Post[]> {
  const clauses = ['hidden = 0', 'thread_id IS NULL'];
  const values: (string | number)[] = [];
  if (channel) {
    clauses.push('channel = ?');
    values.push(channel);
  }
  if (before) {
    clauses.push('seq < ?');
    values.push(before);
  }
  const result = await db.prepare(`SELECT ${publicFields()} FROM posts WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`).bind(...values, LIMITS.pageSize + 1).all<Post>();
  return result.results;
}

export async function listReplies(db: D1Database, threadId: string, after = 0): Promise<Post[]> {
  const result = await db.prepare(`SELECT ${publicFields()} FROM posts WHERE thread_id = ? AND hidden = 0 AND seq > ? ORDER BY seq LIMIT ?`).bind(threadId, after, LIMITS.pageSize + 1).all<Post>();
  return result.results;
}

export async function searchPosts(db: D1Database, query: string, before?: number): Promise<SearchPost[]> {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8);
  if (!terms?.length) return [];
  const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
  const result = await db.prepare(`SELECT ${publicFields('p')}, COALESCE(root.title, p.title) AS thread_title
    FROM posts_fts JOIN posts p ON p.seq = posts_fts.rowid LEFT JOIN posts root ON root.id = p.thread_id
    WHERE posts_fts MATCH ? AND ${visible} AND p.seq < ? ORDER BY p.seq DESC LIMIT ?`).bind(match, before || Number.MAX_SAFE_INTEGER, LIMITS.pageSize + 1).all<SearchPost>();
  return result.results;
}

export async function exportPosts(db: D1Database, after = 0): Promise<Post[]> {
  const result = await db.prepare(`SELECT ${publicFields('p')} FROM posts p WHERE p.seq > ? AND ${visible} ORDER BY p.seq LIMIT 101`).bind(after).all<Post>();
  return result.results;
}

export async function prepareDraft(db: D1Database, input: DraftInput, source: string, now: number): Promise<{ token: string; expires_at: number }> {
  const salt = await db.prepare("SELECT value FROM settings WHERE key = 'privacy_salt'").first<string>('value');
  if (!salt) throw new Error('Missing database privacy salt');
  const day = Math.floor(now / 86400) * 86400;
  const hour = Math.floor(now / 3600) * 3600;
  const clientKey = await hash(`${salt}:${day}:${source}`);
  const token = randomToken();
  const tokenHash = await hash(token);
  const id = crypto.randomUUID();
  const expires = now + LIMITS.draftSeconds;
  const result = await db.prepare(`INSERT INTO drafts
    (token_hash, post_id, thread_id, title, body, author, author_kind, channel, model, client_key, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT count FROM budgets WHERE scope='prepare-day' AND bucket=? AND client_key='*'), 0) < ?
      AND COALESCE((SELECT count FROM budgets WHERE scope='prepare-hour' AND bucket=? AND client_key=?), 0) < ?
      AND (SELECT total_posts FROM counters WHERE id=1) < ?
    RETURNING post_id`).bind(
    tokenHash,
    id,
    input.thread_id,
    input.title,
    input.body,
    input.author,
    input.author_kind,
    input.channel,
    input.model,
    clientKey,
    now,
    expires,
    day,
    LIMITS.preparesPerDayGlobal,
    hour,
    clientKey,
    LIMITS.preparesPerHour,
    LIMITS.totalPosts,
  ).first<{ post_id: string }>();
  if (!result) throw new HTTPException(429, { message: 'The preparation budget has been reached. Please try later; per-source limits reset hourly and the shared budget resets at 00:00 UTC.' });
  return { token, expires_at: expires };
}

export async function publishDraft(db: D1Database, token: string, now: number): Promise<{ post: Post; replayed: boolean }> {
  const tokenHash = await hash(token);
  const existing = () => db.prepare(`SELECT ${publicFields('p')} FROM posts p WHERE p.token_hash = ? AND ${visible}`).bind(tokenHash).first<Post>();
  const prior = await existing();
  if (prior) return { post: prior, replayed: true };
  const draft = await db.prepare('SELECT expires_at, thread_id FROM drafts WHERE token_hash = ?').bind(tokenHash).first<{ expires_at: number; thread_id: string | null }>();
  if (!draft) throw new HTTPException(404, { message: 'This preview does not exist. Prepare a new message.' });
  if (draft.expires_at <= now) throw new HTTPException(410, { message: 'This preview has expired. Prepare the message again to publish it.' });
  const day = Math.floor(now / 86400) * 86400;
  const hour = Math.floor(now / 3600) * 3600;
  const post = await db.prepare(`INSERT INTO posts
    (id, thread_id, title, body, author, author_kind, channel, model, client_key, created_at, updated_at, token_hash)
    SELECT d.post_id, d.thread_id, d.title, d.body, d.author, d.author_kind, d.channel, d.model, d.client_key, ?, ?, d.token_hash
    FROM drafts d WHERE d.token_hash = ? AND d.expires_at > ?
      AND (d.thread_id IS NULL OR EXISTS (SELECT 1 FROM posts root WHERE root.id = d.thread_id AND root.thread_id IS NULL AND root.hidden = 0))
      AND COALESCE((SELECT count FROM budgets WHERE scope='post-day' AND bucket=? AND client_key='*'), 0) < ?
      AND COALESCE((SELECT count FROM budgets WHERE scope='post-hour' AND bucket=? AND client_key=d.client_key), 0) < ?
      AND (SELECT total_posts FROM counters WHERE id=1) < ?
    ON CONFLICT(token_hash) DO NOTHING RETURNING ${publicFields()}`).bind(now, now, tokenHash, now, day, LIMITS.postsPerDayGlobal, hour, LIMITS.postsPerHour, LIMITS.totalPosts).first<Post>();
  if (post) return { post, replayed: false };
  const concurrent = await existing();
  if (concurrent) return { post: concurrent, replayed: true };
  if (draft.thread_id && !await getPost(db, draft.thread_id)) throw new HTTPException(409, { message: 'This thread is no longer available.' });
  const hidden = await db.prepare('SELECT id FROM posts WHERE token_hash = ?').bind(tokenHash).first<{ id: string }>();
  if (hidden) throw new HTTPException(410, { message: 'This message is no longer public.' });
  throw new HTTPException(429, { message: 'The posting budget has been reached. Please try later; source limits reset hourly and the shared budget resets at 00:00 UTC.' });
}

export async function prunePrivateData(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM drafts WHERE token_hash IN (SELECT token_hash FROM drafts WHERE expires_at < ? LIMIT 100)').bind(now - 86400),
    db.prepare('DELETE FROM budgets WHERE rowid IN (SELECT rowid FROM budgets WHERE bucket < ? LIMIT 100)').bind(now - 2 * 86400),
    db.prepare("UPDATE posts SET client_key = '' WHERE seq IN (SELECT seq FROM posts WHERE client_key != '' AND created_at < ? ORDER BY created_at LIMIT 100)").bind(now - 2 * 86400),
  ]);
}

export function postPath(post: Pick<Post, 'id' | 'thread_id' | 'seq'>): string {
  return `/t/${post.thread_id || post.id}${post.thread_id ? `?after=${post.seq - 1}#p-${post.id}` : ''}`;
}
