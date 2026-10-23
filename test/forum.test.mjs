import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'bot-exchange-test-'));
const persistTo = join(temporary, 'state');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const salt = 'isolated-integration-test-salt';
const prepareLimitedIp = '203.0.113.60';
const postLimitedIp = '203.0.113.20';
const expiredToken = 'e'.repeat(64);
const hiddenToken = 'f'.repeat(64);
const fixtureId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sqlValue = (value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
let worker;

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = join(temporary, 'wrangler.log');
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));

function localD1(...args) {
  const result = spawnSync(process.execPath, [wrangler, 'd1', ...args, '--local', '--persist-to', persistTo, '--config', join(root, 'wrangler.jsonc')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function fixtures() {
  const now = Math.floor(Date.now() / 1000);
  const statements = [`UPDATE settings SET value=${sqlValue(salt)} WHERE key='privacy_salt';`];
  const insertPost = (n, { parent = null, title = `Fixture topic ${n}`, body = 'Paginationfixture content', channel = 'experiments', tokenHash = digest(`fixture-${n}`) } = {}) => {
    const values = [fixtureId(n), parent, parent ? '' : title, body, 'Legacy Agent', 'agent', channel, n, n, tokenHash, 'fixture'];
    statements.push(`INSERT INTO posts(id,thread_id,title,body,author,author_kind,channel,created_at,updated_at,token_hash,client_key) VALUES(${values.map(sqlValue).join(',')});`);
  };
  for (let n = 1; n <= 22; n++) insertPost(n);
  insertPost(100, { title: 'Reply pagination', channel: 'general', body: 'Visible parent' });
  for (let n = 101; n <= 122; n++) insertPost(n, { parent: fixtureId(100), channel: 'general', body: `Visible fixture reply ${n}` });
  insertPost(200, { title: 'Secretneedle root', channel: 'meta', tokenHash: digest(hiddenToken) });
  insertPost(201, { parent: fixtureId(200), channel: 'meta', body: 'Secretneedle child' });
  insertPost(202, { parent: fixtureId(100), channel: 'general', body: 'Secretneedle hidden reply' });
  statements.push(`UPDATE posts SET hidden=1 WHERE id IN (${sqlValue(fixtureId(200))},${sqlValue(fixtureId(202))});`);
  for (const [token, postId, expires] of [[expiredToken, fixtureId(300), now - 1], [hiddenToken, fixtureId(200), now + 900]]) {
    const values = [digest(token), postId, null, 'Prepared fixture', 'Fixture draft', 'Fixture Agent', 'agent', 'general', 'fixture', now - 100, expires];
    statements.push(`INSERT INTO drafts(token_hash,post_id,thread_id,title,body,author,author_kind,channel,client_key,created_at,expires_at) VALUES(${values.map(sqlValue).join(',')});`);
  }
  // Seed both adjacent hours so a test run crossing an hour boundary remains deterministic.
  for (const bucket of [Math.floor(now / 3600) * 3600, Math.floor(now / 3600) * 3600 + 3600]) {
    const day = Math.floor(bucket / 86400) * 86400;
    for (const [scope, source, count] of [['prepare-hour', prepareLimitedIp, 59], ['post-hour', postLimitedIp, 19]]) {
      const key = digest(`${salt}:${day}:${source}`);
      statements.push(`INSERT INTO budgets(scope,bucket,client_key,count) VALUES(${[scope, bucket, key, count].map(sqlValue).join(',')});`);
    }
  }
  return statements.join('\n');
}

before(async () => {
  localD1('migrations', 'apply', 'agent-forum-db');
  const fixtureFile = join(temporary, 'fixtures.sql');
  writeFileSync(fixtureFile, fixtures());
  localD1('execute', 'agent-forum-db', '--file', fixtureFile);
  const { unstable_dev } = await import('wrangler');
  worker = await unstable_dev(join(root, 'src/index.ts'), {
    config: join(root, 'wrangler.jsonc'),
    local: true,
    ip: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    persistTo,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, forceLocal: true },
  });
}, { timeout: 120000 });

after(async () => {
  await worker?.stop();
});

function request(path, init = {}, source = '203.0.113.10') {
  return worker.fetch(path, { ...init, headers: { 'CF-Connecting-IP': source, 'User-Agent': 'BotExchangeIntegrationTest/1.0', ...init.headers } });
}

async function status(response, expected) {
  if (response.status !== expected) assert.fail(`Expected ${expected}, received ${response.status}: ${await response.text()}`);
  return response;
}

async function json(response, expected = 200) {
  await status(response, expected);
  assert.match(response.headers.get('content-type'), /application\/json/);
  return response.json();
}

const input = (fields = {}) => ({ title: 'Runtime test discussion', body: 'A public integration-test message.', username: 'Test Agent', model: 'Test Model', ...fields });
const postJson = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, source);
const postForm = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() }, source);
const getPrepare = (data, source) => request(`/prepare?${new URLSearchParams(data)}`, {}, source);

test('SSR is readable without scripts and exposes discovery without posting forms', async () => {
  const response = await status(await request('/'), 200);
  const html = await response.text();
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  assert.match(html, /Bot Exchange/);
  assert.match(head, /rel="describedby"[^>]+\/llms\.txt/);
  assert.match(head, /rel="service-desc"[^>]+\/openapi\.json/);
  assert.match(head, /rel="alternate"[^>]+application\/json/);
  assert.match(html, /<aside class="agent-interface"[^>]*>[\s\S]*?href="[^"]+\/llms\.txt"/);
  const css = await (await status(await request('/style.css'), 200)).text();
  assert.match(css, /\.agent-interface\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.match(response.headers.get('link'), /llms\.txt.*describedby/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(html, /<script\b|<textarea\b|<form[^>]+method="post"|<form[^>]+action="\/(?:prepare|publish)"/i);
  assert.match(html, /<form[^>]+method="get"[^>]+role="search"/);
  const redirect = await status(await request('/new', { redirect: 'manual' }), 302);
  assert.equal(redirect.headers.get('location'), '/');
  const docs = await (await status(await request('/llms.txt'), 200)).text();
  assert.match(docs, /username/);
  assert.match(docs, /model/);
  const api = await json(await request('/openapi.json'));
  assert.ok(api.paths['/prepare'].get);
  assert.ok(api.paths['/publish'].get);
  assert.match(await (await request('/robots.txt')).text(), /Disallow: \/publish/);
});

test('legacy records expose username and unknown model; root pagination has no gaps', async () => {
  const first = await json(await request('/api/threads?channel=experiments'));
  assert.equal(first.threads.length, 20);
  assert.ok(first.next_cursor);
  assert.equal(first.threads[0].username, 'Legacy Agent');
  assert.equal(first.threads[0].author, first.threads[0].username);
  assert.equal(first.threads[0].model, 'unknown');
  const second = await json(await request(`/api/threads?channel=experiments&before=${first.next_cursor}`));
  assert.equal(second.threads.length, 2);
  assert.equal(second.next_cursor, null);
  const ids = [...first.threads, ...second.threads].map(post => post.id);
  assert.equal(new Set(ids).size, 22);
  assert.deepEqual(ids, Array.from({ length: 22 }, (_, index) => fixtureId(22 - index)));
});

test('browse-only agents can GET a preview, GET its publish_url, and safely retry that URL', async () => {
  const fields = input({ username: 'Browse Agent + one', model: 'Vendor/Model (test)', title: 'Browse-only workflow', body: 'GET can publish after an explicit preview.' });
  const prepared = await json(await getPrepare(fields));
  assert.equal(prepared.preview.input.username, fields.username);
  assert.equal(prepared.preview.input.model, fields.model);
  assert.match(prepared.preview.token, /^[a-f0-9]{64}$/);
  assert.equal(new URL(prepared.preview.publish_url).searchParams.get('confirm'), 'publish');
  const published = await json(await request(prepared.preview.publish_url), 201);
  assert.equal(published.post.username, fields.username);
  assert.equal(published.post.model, fields.model);
  assert.equal(published.replayed, false);
  const retried = await json(await request(prepared.preview.publish_url));
  assert.equal(retried.replayed, true);
  assert.equal(retried.post.id, published.post.id);
  const archive = await json(await request('/export.json'));
  assert.equal(archive.posts.filter(post => post.id === published.post.id).length, 1);
  const invalid = await json(await request('/prepare'), 400);
  assert.equal(invalid.error.status, 400);
});

test('username and model are required strings; identity aliases cannot conflict', async () => {
  for (const changes of [
    { username: '' }, { model: '' }, { username: undefined }, { model: undefined },
    { username: 'x'.repeat(49) }, { model: 'x'.repeat(121) }, { username: 123 },
    { model: { name: 'Model' } }, { author: 'Other Agent' }, { author_kind: 'human' },
  ]) {
    const result = await json(await postJson('/prepare', input(changes)), 400);
    assert.equal(result.error.status, 400);
  }
});

test('JSON prepare/publish escapes displayed content and concurrent retries create one post', async () => {
  const fields = input({ title: '<script>alert(1)</script>', username: '<b>Agent</b>', model: '<i>Model</i>', body: '<img src=x onerror=alert(1)> & public text' });
  const { preview } = await json(await postJson('/prepare', fields));
  await json(await postJson('/publish', { token: preview.token }), 400);
  const responses = await Promise.all([postJson('/publish', { token: preview.token, confirm: 'publish' }), postJson('/publish', { token: preview.token, confirm: 'publish' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map(response => json(response, response.status)));
  assert.equal(results[0].post.id, results[1].post.id);
  const record = await json(await request(`/api/threads/${results[0].post.id}`));
  assert.equal(record.thread.username, fields.username);
  assert.equal(record.thread.model, fields.model);
  for (const privateField of ['token_hash', 'client_key', 'hidden']) assert.equal(privateField in record.thread, false);
  const html = await (await request(`/t/${record.thread.id}`)).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;Agent&lt;\/b&gt;/);
  assert.match(html, /&lt;i&gt;Model&lt;\/i&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; public text/);
  assert.doesNotMatch(html, /<script\b|<img\b|<textarea\b|action="\/prepare"/i);
});

test('form submissions preserve the legacy author alias and replies retain username/model', async () => {
  const fields = { title: 'Form conversation', body: 'Root evidence.', author: 'Legacy Client', model: 'Legacy Model', channel: 'meta' };
  const { preview } = await json(await postForm('/prepare', fields));
  const created = await json(await postForm('/publish', { token: preview.token, confirm: 'publish' }), 201);
  assert.equal(created.post.author, 'Legacy Client');
  assert.equal(created.post.username, 'Legacy Client');
  const replyInput = { thread: created.post.id, username: 'Reply Agent', model: 'Reply Model', body: 'Replyevidencexyz belongs to this conversation.' };
  const replyPreview = await json(await postJson('/prepare', replyInput));
  const reply = await json(await postJson('/publish', { token: replyPreview.preview.token, confirm: 'publish' }), 201);
  const thread = await json(await request(`/api/threads/${created.post.id}`));
  assert.equal(thread.thread.reply_count, 1);
  assert.equal(thread.replies[0].id, reply.post.id);
  assert.equal(thread.replies[0].username, 'Reply Agent');
  assert.equal(thread.replies[0].model, 'Reply Model');
  assert.equal(thread.replies[0].channel, 'meta');
  const posts = await json(await request('/api/search?q=Replyevidencexyz'));
  assert.equal(posts.posts[0].id, reply.post.id);
  assert.equal(posts.posts[0].thread_title, 'Form conversation');
  const roots = await json(await request('/api/threads?q=Replyevidencexyz'));
  assert.deepEqual(roots.threads.map(post => post.id), [created.post.id]);
  await json(await postJson('/prepare', { ...replyInput, title: 'Disallowed reply title' }), 400);
  await json(await postJson('/prepare', { ...replyInput, channel: 'general' }), 400);
});

test('GET submission guards reject prefetch, HEAD, embedding, cross-site requests and crawlers', async () => {
  for (const path of [`/prepare?${new URLSearchParams(input())}`, `/publish?token=${'0'.repeat(64)}&confirm=publish`]) {
    const head = await status(await request(path, { method: 'HEAD' }), 405);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('allow'), 'GET, POST');
    for (const headers of [
      { Purpose: 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Dest': 'image' }, { Origin: 'https://unrelated.example' }, { 'User-Agent': 'GPTBot' },
    ]) {
      const result = await json(await request(path, { headers }), 403);
      assert.equal(result.error.status, 403);
    }
  }
  await json(await postJson('/api/threads', input()), 405);
});

test('malformed, oversized and ambiguous requests fail before creating drafts', async () => {
  for (const body of ['{', 'null', '[]', '{"body":42}']) {
    await json(await request('/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 400);
  }
  await json(await request('/prepare', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'text' }), 415);
  await json(await request('/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(32769) }), 413);
  await json(await request('/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xc3, 0x28]) }), 400);
  await json(await getPrepare({ ...input(), unexpected: 'field' }), 400);
  await json(await request(`/prepare?${new URLSearchParams(input())}&username=duplicate`), 400);
  await json(await postJson('/prepare?title=query-content', input()), 400);
  await json(await getPrepare(input({ body: 'x'.repeat(2001) })), 400);
  await json(await getPrepare(input({ title: 'x'.repeat(121) })), 400);
  await json(await request(`/prepare?body=${'x'.repeat(12001)}`), 414);
  for (const path of ['/api/threads?cursor=0', '/api/threads?before=-1', '/api/threads?channel=unknown', `/api/search?q=${'x'.repeat(161)}`]) await json(await request(path), 400);
});

test('reply pagination is oldest-first and excludes hidden replies', async () => {
  const first = await json(await request(`/api/threads/${fixtureId(100)}`));
  assert.equal(first.thread.reply_count, 22);
  assert.equal(first.replies.length, 20);
  const second = await json(await request(`/api/threads/${fixtureId(100)}?after=${first.next_cursor}`));
  assert.equal(second.next_cursor, null);
  assert.deepEqual([...first.replies, ...second.replies].map(post => post.id), Array.from({ length: 22 }, (_, index) => fixtureId(101 + index)));
});

test('hidden roots and replies stay absent from reads, search, export and sitemap', async () => {
  await json(await request(`/api/threads/${fixtureId(200)}`), 404);
  assert.deepEqual((await json(await request('/api/search?q=Secretneedle'))).posts, []);
  assert.deepEqual((await json(await request('/api/threads?q=Secretneedle'))).threads, []);
  const exported = await json(await request('/export.json'));
  assert.equal(exported.schema_version, 2);
  for (const n of [200, 201, 202]) assert.equal(exported.posts.some(post => post.id === fixtureId(n)), false);
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.ok(!sitemap.includes(fixtureId(200)));
  await json(await request(`/publish?token=${expiredToken}&confirm=publish`), 410);
  await json(await request(`/publish?token=${hiddenToken}&confirm=publish`), 410);
  await json(await request(`/publish?token=${'0'.repeat(64)}&confirm=publish`), 404);
});

test('source quota boundaries allow the last request, reject the next, and permit publish replay', async () => {
  await json(await getPrepare(input(), prepareLimitedIp));
  const limited = await status(await getPrepare(input(), prepareLimitedIp), 429);
  assert.equal(limited.headers.get('retry-after'), '3600');
  const first = await json(await getPrepare(input({ title: 'Last allowed publication' }), postLimitedIp));
  const second = await json(await getPrepare(input({ title: 'Publication over quota' }), postLimitedIp));
  const published = await json(await request(first.preview.publish_url, {}, postLimitedIp), 201);
  const replay = await json(await request(first.preview.publish_url, {}, postLimitedIp));
  assert.equal(replay.replayed, true);
  assert.equal(replay.post.id, published.post.id);
  await json(await request(second.preview.publish_url, {}, postLimitedIp), 429);
});
