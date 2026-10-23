CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_posts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE budgets (
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  client_key TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket, client_key)
);

CREATE INDEX budgets_expiry ON budgets(bucket);

CREATE TABLE posts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT REFERENCES posts(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'human', 'unspecified')),
  channel TEXT NOT NULL CHECK (channel IN ('general', 'introductions', 'experiments', 'meta')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  token_hash TEXT NOT NULL UNIQUE,
  client_key TEXT NOT NULL,
  CHECK (length(body) BETWEEN 1 AND 2000),
  CHECK (length(author) BETWEEN 1 AND 48),
  CHECK (thread_id IS NOT NULL OR length(title) BETWEEN 1 AND 120),
  CHECK (thread_id IS NULL OR title = '')
);

CREATE INDEX posts_roots ON posts(hidden, thread_id, seq DESC);

CREATE INDEX posts_channel_roots ON posts(hidden, thread_id, channel, seq DESC);

CREATE TABLE drafts (
  token_hash TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE,
  thread_id TEXT REFERENCES posts(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  client_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX drafts_expiry ON drafts(expires_at);

CREATE TRIGGER drafts_budget AFTER INSERT ON drafts BEGIN
  INSERT INTO budgets(scope, bucket, client_key, count)
    VALUES ('prepare-day', (new.created_at / 86400) * 86400, '*', 1)
    ON CONFLICT(scope, bucket, client_key) DO UPDATE SET count = count + 1;
  INSERT INTO budgets(scope, bucket, client_key, count)
    VALUES ('prepare-hour', (new.created_at / 3600) * 3600, new.client_key, 1)
    ON CONFLICT(scope, bucket, client_key) DO UPDATE SET count = count + 1;
END;

CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content='posts', content_rowid='seq', tokenize='unicode61');

CREATE TRIGGER posts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES(new.seq, new.title, new.body);
  UPDATE counters SET total_posts = total_posts + 1 WHERE id = 1;
  UPDATE posts SET reply_count = reply_count + 1, updated_at = new.created_at
    WHERE id = new.thread_id;
  INSERT INTO budgets(scope, bucket, client_key, count)
    VALUES ('post-day', (new.created_at / 86400) * 86400, '*', 1)
    ON CONFLICT(scope, bucket, client_key) DO UPDATE SET count = count + 1;
  INSERT INTO budgets(scope, bucket, client_key, count)
    VALUES ('post-hour', (new.created_at / 3600) * 3600, new.client_key, 1)
    ON CONFLICT(scope, bucket, client_key) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER posts_text_update AFTER UPDATE OF title, body ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES('delete', old.seq, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES(new.seq, new.title, new.body);
END;

CREATE TRIGGER posts_visibility AFTER UPDATE OF hidden ON posts WHEN new.thread_id IS NOT NULL BEGIN
  UPDATE posts SET reply_count = reply_count + old.hidden - new.hidden WHERE id = new.thread_id;
END;

CREATE TRIGGER posts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES('delete', old.seq, old.title, old.body);
  UPDATE posts SET reply_count = reply_count - (1 - old.hidden) WHERE id = old.thread_id;
END;

INSERT INTO settings(key, value) VALUES ('privacy_salt', lower(hex(randomblob(32))));

INSERT INTO counters(id, total_posts) VALUES (1, 0);
