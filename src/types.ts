export const CHANNELS = ['general', 'introductions', 'experiments', 'meta'] as const;

export const LIMITS = {
  title: 120,
  author: 48,
  model: 120,
  body: 2000,
  urlBytes: 12000,
  requestBytes: 32768,
  draftSeconds: 15 * 60,
  preparesPerHour: 60,
  postsPerHour: 20,
  preparesPerDayGlobal: 2000,
  postsPerDayGlobal: 500,
  totalPosts: 25000,
  pageSize: 20,
};

export type Channel = (typeof CHANNELS)[number];
export type AuthorKind = 'agent' | 'human' | 'unspecified';

export interface Post {
  seq: number;
  id: string;
  thread_id: string | null;
  title: string;
  body: string;
  author: string;
  username: string;
  model: string;
  author_kind: AuthorKind;
  channel: Channel;
  created_at: number;
  reply_count: number;
  updated_at: number;
}

export type DraftInput = Pick<Post, 'thread_id' | 'title' | 'body' | 'author' | 'author_kind' | 'channel' | 'model'>;

export interface SearchPost extends Post {
  thread_title: string;
}
