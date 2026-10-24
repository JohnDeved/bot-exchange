import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'bot-exchange-cleanup-test-'));
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));
const bundle = await build({
  entryPoints: [join(root, 'src/storage.ts')], bundle: true,
  platform: 'node', target: 'es2022', format: 'esm', write: false,
});
const modulePath = join(temporary, 'storage.mjs');
writeFileSync(modulePath, bundle.outputFiles[0].text);
const { prunePrivateData } = await import(pathToFileURL(modulePath).href);

test('privacy cleanup uses the partial expiry index and clears at most 100 old client keys', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of ['0001_forum.sql', '0002_agent_identity.sql']) {
    db.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
  }
  const now = 2_000_000_000;
  const cutoff = now - 2 * 86400;
  const insert = db.prepare(`INSERT INTO posts
    (seq, id, title, body, author, author_kind, channel, created_at, updated_at, token_hash, client_key, hidden)
    VALUES (?, ?, 'Preserved title', 'Preserved body', 'fixture', 'agent', 'general', ?, ?, ?, ?, ?)`);
  const add = (seq, created, key, hidden = 0) => insert.run(seq, `fixture-${seq}`, created, created, `unused-${seq}`, key, hidden);
  db.exec('BEGIN');
  for (let seq = 1; seq <= 5000; seq++) add(seq, cutoff - 1000, '');
  for (let seq = 5001; seq <= 5150; seq++) add(seq, cutoff - (seq - 5000), 'private', seq === 5150 ? 1 : 0);
  add(6000, cutoff, 'boundary');
  add(6001, cutoff + 1, 'recent');
  db.exec('COMMIT');

  let statements;
  await prunePrivateData({
    prepare: sql => ({ bind: (...values) => ({ sql, values }) }),
    batch: async batch => { statements = batch; },
  }, now);
  const cleanup = statements.find(statement => statement.sql.startsWith('UPDATE posts'));
  const plan = () => db.prepare(`EXPLAIN QUERY PLAN ${cleanup.sql}`).all(...cleanup.values).map(row => row.detail).join('\n');
  assert.match(plan(), /SCAN posts/, 'The fixture must reproduce the missing-index scan');
  const publicRows = () => db.prepare('SELECT seq, id, thread_id, title, body, author, author_kind, channel, model, created_at, updated_at, reply_count, hidden FROM posts ORDER BY seq').all();
  const before = publicRows();
  db.exec(readFileSync(join(root, 'migrations/0003_private_cleanup.sql'), 'utf8'));
  assert.match(plan(), /SEARCH posts USING INDEX posts_private_expiry \(created_at<\?\)/);
  assert.doesNotMatch(plan(), /SCAN posts|USE TEMP B-TREE/);

  const run = () => {
    db.exec('BEGIN');
    for (const statement of statements) db.prepare(statement.sql).run(...statement.values);
    db.exec('COMMIT');
  };
  const remainingOld = () => db.prepare("SELECT seq FROM posts WHERE client_key != '' AND created_at < ? ORDER BY seq").all(cutoff).map(row => row.seq);
  run();
  assert.deepEqual(remainingOld(), Array.from({ length: 50 }, (_, index) => 5001 + index), 'Each run clears the oldest 100 eligible rows, including hidden posts');
  run();
  assert.deepEqual(remainingOld(), []);
  run();
  assert.deepEqual(db.prepare("SELECT seq, client_key FROM posts INDEXED BY posts_private_expiry WHERE client_key != '' ORDER BY created_at").all().map(row => ({ ...row })), [
    { seq: 6000, client_key: 'boundary' },
    { seq: 6001, client_key: 'recent' },
  ], 'Cleared rows leave the index; the exact retention boundary and newer keys remain');
  assert.deepEqual(publicRows(), before, 'Migration and cleanup preserve all public post fields');
  assert.match(plan(), /SEARCH posts USING INDEX posts_private_expiry/);
});
