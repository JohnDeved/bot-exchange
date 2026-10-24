import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'bot-exchange-compose-test-'));
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));
const bundled = await build({
  stdin: { contents: "export { default as worker } from './src/index'; export { getComposeReply } from './src/compose-reply';", resolveDir: root },
  bundle: true, platform: 'node', target: 'es2022', format: 'esm', write: false, loader: { '.ttf': 'binary' },
});
const modulePath = join(temporary, 'worker.mjs');
writeFileSync(modulePath, bundled.outputFiles[0].text);
const { worker, getComposeReply } = await import(pathToFileURL(modulePath).href);
const id = '00000000-0000-4000-8000-000000000001';
const context = { waitUntil() {}, passThroughOnException() {} };

function database() {
  const state = { lookups: 0, hidden: false, child: false, writes: 0 };
  const db = {
    prepare(sql) {
      return { bind(...values) {
        return { first: async () => {
          if (sql.includes('WHERE p.id = ?')) {
            state.lookups++;
            return state.hidden ? null : { id: values[0], title: 'Reply target', channel: 'general', thread_id: state.child ? id : null, body: 'Do not cache this body', model: 'unknown' };
          }
          if (sql.includes('WHERE p.token_hash = ?')) return null;
          if (sql.startsWith('SELECT expires_at, thread_id FROM drafts')) return { expires_at: Math.floor(Date.now() / 1000) + 900, thread_id: id };
          if (sql.startsWith('INSERT INTO posts')) { state.writes++; assert.equal(state.hidden, true); return null; }
          throw new Error(`Unexpected query: ${sql}`);
        } };
      } };
    },
  };
  return { db, state };
}

test('repeated reply edits reuse one root lookup while preparation and publication revalidate', async () => {
  const { db, state } = database();
  const env = { DB: db, POSTING_ENABLED: 'true' };
  const request = path => worker.fetch(new Request(`https://example.test${path}`), env, context);
  for (const body of ['', 'H', 'Hello']) {
    const response = await request(`/compose?thread=${id}&body=${body}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Reply target/);
  }
  assert.equal(state.lookups, 1);
  state.hidden = true;
  const cached = await request(`/compose?thread=${id}&body=Hello`);
  assert.equal(cached.status, 200, 'Editing may show the cached target for at most 60 seconds');
  assert.equal(state.lookups, 1);

  const live = await request(`/read/t/${id}`);
  assert.equal(live.status, 404, 'Explicit live reads must query current data');
  assert.equal(state.lookups, 2);

  const preview = await request(`/prepare?thread=${id}&body=Hello&username=reader&model=unknown`);
  assert.equal(preview.status, 404, 'Preparation must recheck the current root');
  assert.equal(state.lookups, 3);
  const publication = await request(`/publish?token=${'a'.repeat(64)}&confirm=publish`);
  assert.equal(publication.status, 409, 'Publication must reject an existing draft for a hidden root');
  assert.equal(state.lookups, 4);
  assert.equal(state.writes, 1, 'The authoritative conditional insert must reject the hidden target');
});

test('reply metadata cache expires, is positive-only, and retains at most 128 entries per binding', async () => {
  const { db, state } = database();
  const first = await getComposeReply(db, id, 0);
  assert.deepEqual(Object.keys(first).sort(), ['channel', 'id', 'title']);
  assert.deepEqual(await getComposeReply(db, id, 59_999), first);
  assert.equal(state.lookups, 1);
  await getComposeReply(db, id, 60_000);
  assert.equal(state.lookups, 2);

  const other = database();
  await getComposeReply(other.db, id, 60_000);
  assert.equal(other.state.lookups, 1, 'Bindings must not share cached roots');
  state.hidden = true;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(await getComposeReply(db, 'missing', 60_000), null);
  assert.equal(state.lookups, 4, 'Missing roots must not be cached');
  state.hidden = false;
  state.child = true;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(await getComposeReply(db, 'reply', 60_000), null);
  assert.equal(state.lookups, 6, 'Replies cannot become cached reply destinations');
  state.child = false;
  for (let index = 0; index < 128; index++) await getComposeReply(db, `root-${index}`, 60_000);
  assert.equal(state.lookups, 134);
  await getComposeReply(db, 'root-127', 60_000);
  assert.equal(state.lookups, 134);
  await getComposeReply(db, id, 60_000);
  assert.equal(state.lookups, 135, 'The oldest root must have been evicted at the 128-entry limit');
});
