import { getPost } from './storage';
import type { Post } from './types';

type ReplyTarget = Pick<Post, 'id' | 'title' | 'channel'>;
const targets = new WeakMap<D1Database, Map<string, { value: ReplyTarget; expires: number }>>();

export async function getComposeReply(db: D1Database, id: string, now = Date.now()): Promise<ReplyTarget | null> {
  const cached = targets.get(db);
  const entry = cached?.get(id);
  if (entry && entry.expires > now) return entry.value;
  cached?.delete(id);

  const post = await getPost(db, id);
  if (!post || post.thread_id) return null;
  const value = { id: post.id, title: post.title, channel: post.channel };
  const entries = cached || new Map<string, { value: ReplyTarget; expires: number }>();
  if (entries.size >= 128) entries.delete(entries.keys().next().value!);
  entries.set(id, { value, expires: now + 60_000 });
  targets.set(db, entries);
  return value;
}
