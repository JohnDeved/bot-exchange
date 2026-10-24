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
const composeLimitedIp = '203.0.113.61';
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
  for (let n = 400; n <= 421; n++) insertPost(n, { title: `Idea fixture ${n}`, body: 'Ideafixturetoken feature suggestion', channel: 'meta' });
  insertPost(422, { title: 'Hidden idea fixture', body: 'Ideafixturetoken hidden suggestion', channel: 'meta' });
  statements.push(`UPDATE posts SET hidden=1 WHERE id=${sqlValue(fixtureId(422))};`);
  statements.push(`UPDATE posts SET body='Paginationfixture Ideafixturetoken non-idea match' WHERE id=${sqlValue(fixtureId(1))};`);
  insertPost(423, { parent: fixtureId(400), channel: 'meta', body: 'Ideareplyonly feature discussion' });
  insertPost(424, { parent: fixtureId(1), channel: 'experiments', body: 'Ideareplyonly unrelated discussion' });
  for (const [token, postId, expires] of [[expiredToken, fixtureId(300), now - 1], [hiddenToken, fixtureId(200), now + 900]]) {
    const values = [digest(token), postId, null, 'Prepared fixture', 'Fixture draft', 'Fixture Agent', 'agent', 'general', 'fixture', now - 100, expires];
    statements.push(`INSERT INTO drafts(token_hash,post_id,thread_id,title,body,author,author_kind,channel,client_key,created_at,expires_at) VALUES(${values.map(sqlValue).join(',')});`);
  }
  // Seed both adjacent hours so a test run crossing an hour boundary remains deterministic.
  for (const bucket of [Math.floor(now / 3600) * 3600, Math.floor(now / 3600) * 3600 + 3600]) {
    const day = Math.floor(bucket / 86400) * 86400;
    for (const [scope, source, count] of [['prepare-hour', prepareLimitedIp, 59], ['prepare-hour', composeLimitedIp, 59], ['post-hour', postLimitedIp, 19]]) {
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

const decodeHtml = value => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  return named[entity] ?? String.fromCodePoint(entity[2].toLowerCase() === 'x' ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
});

async function html(response, expected = 200) {
  await status(response, expected);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const source = await response.text();
  return {
    source,
    headers: response.headers,
    text: decodeHtml(source.replace(/<[^>]*>/g, ' ')),
    links: Array.from(source.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/g), match => decodeHtml(match[1])),
    anchors: Array.from(source.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g), match => ({
      href: decodeHtml(match[1]),
      text: decodeHtml(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
    })),
  };
}

function actionLink(page, pathname) {
  const links = page.links.filter(href => /^https?:\/\//.test(href) && new URL(href).pathname === pathname);
  assert.equal(links.length, 1, `Expected one absolute link to ${pathname}`);
  return links[0];
}

async function followText(page, label, source) {
  const matches = page.anchors.filter(anchor => anchor.text === label);
  assert.equal(matches.length, 1, `Expected one link labelled ${label}`);
  assert.match(matches[0].href, /^https?:\/\//, 'Composer links must be absolute');
  return html(await request(matches[0].href, {}, source));
}

const input = (fields = {}) => ({ title: 'Runtime test discussion', body: 'A public integration-test message.', username: 'Test Agent', model: 'Test Model', ...fields });
const postJson = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, source);
const postForm = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() }, source);
const getPrepare = (data, source) => request(`/prepare?${new URLSearchParams({ format: 'json', ...data })}`, {}, source);

test('SSR is readable without scripts and exposes discovery without posting forms', async () => {
  const response = await status(await request('/'), 200);
  const html = await response.text();
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  assert.match(html, /Bot Exchange/);
  assert.match(head, /rel="describedby"[^>]+\/llms\.txt/);
  assert.match(head, /rel="service-desc"[^>]+\/openapi\.json/);
  assert.match(head, /rel="alternate"[^>]+application\/json/);
  assert.match(html, /<(?:p|aside) class="agent-interface"[^>]*>[\s\S]*?href="[^"]+\/llms\.txt"/);
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

test('JSON browse clients can GET a preview, GET its publish_url, and safely retry that URL', async () => {
  const fields = input({ username: 'Browse Agent + one', model: 'Vendor/Model (test)', title: 'Browse-only workflow', body: 'GET can publish after an explicit preview.' });
  const prepared = await json(await getPrepare(fields));
  assert.equal(prepared.preview.input.username, fields.username);
  assert.equal(prepared.preview.input.model, fields.model);
  assert.match(prepared.preview.token, /^[a-f0-9]{64}$/);
  assert.equal(new URL(prepared.preview.publish_url).searchParams.get('confirm'), 'publish');
  assert.equal(new URL(prepared.preview.publish_url).searchParams.get('format'), 'json');
  const published = await json(await request(prepared.preview.publish_url), 201);
  assert.equal(published.post.username, fields.username);
  assert.equal(published.post.model, fields.model);
  assert.equal(published.replayed, false);
  const retried = await json(await request(prepared.preview.publish_url));
  assert.equal(retried.replayed, true);
  assert.equal(retried.post.id, published.post.id);
  const archive = await json(await request('/export.json'));
  assert.equal(archive.posts.filter(post => post.id === published.post.id).length, 1);
  const invalid = await json(await request('/prepare?format=json'), 400);
  assert.equal(invalid.error.status, 400);
});

test('HTML-only browsing can review, publish and follow a thread and reply without duplicate retries', async () => {
  const fields = input({ title: '  Htmlbrowseflowtoken <review> & publish  ', body: '  First line <b>plain text</b> & evidence.\r\nSecond line: café.  ', username: '  Browse <Agent> + one  ', model: '  Vendor/Model "test"  ', channel: 'meta' });
  const expected = { ...fields, title: fields.title.trim(), body: fields.body.trim().replaceAll('\r\n', '\n'), username: fields.username.trim(), model: fields.model.trim() };
  const preview = await html(await request(`/prepare?${new URLSearchParams(fields)}`));
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(preview.headers.get('vary'), 'Accept');
  assert.match(preview.source, /<a\b[^>]*href="https?:\/\/[^"]+\/publish\?[^"]*"[^>]*rel="nofollow"/);
  for (const value of [expected.title, expected.body, `Username: ${expected.username}`, `Model: ${expected.model}`, 'Author kind: agent', 'Channel: meta', 'Destination: New thread', 'Draft expires:']) assert.ok(preview.text.includes(value), `Preview is missing ${value}`);
  assert.doesNotMatch(preview.source, /<script\b|<b\b|<review\b|<Agent\b/i);
  const expiry = preview.source.match(/<time\b[^>]*datetime="([^"]+)"/);
  assert.ok(expiry);
  assert.ok(Date.parse(expiry[1]) > Date.now());
  const publishUrl = actionLink(preview, '/publish');
  assert.equal(new URL(publishUrl).searchParams.get('format'), null);
  assert.equal(new URL(publishUrl).searchParams.get('confirm'), 'publish');
  assert.match(new URL(publishUrl).searchParams.get('token'), /^[a-f0-9]{64}$/);
  assert.deepEqual((await json(await request('/api/ideas?q=Htmlbrowseflowtoken'))).threads, []);

  const published = await html(await request(publishUrl));
  assert.equal(published.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(published.headers.get('vary'), 'Accept');
  for (const value of [expected.title, expected.body, expected.username, expected.model, 'Author kind: agent', 'Channel: meta']) assert.ok(published.text.includes(value), `Receipt is missing ${value}`);
  const threadUrl = published.links.find(href => /^https?:\/\/[^/]+\/t\/[^/?#]+$/.test(href));
  assert.ok(threadUrl, 'Publication must link to the absolute canonical thread URL');
  const threadId = new URL(threadUrl).pathname.slice('/t/'.length);
  const threadPage = await html(await request(threadUrl));
  for (const value of [expected.title, expected.body, expected.username, expected.model]) assert.ok(threadPage.text.includes(value), `Thread is missing ${value}`);
  assert.doesNotMatch(threadPage.source, /<script\b|<b\b|<review\b|<Agent\b/i);
  const replay = await html(await request(publishUrl));
  assert.equal(actionLink(replay, `/t/${threadId}`), threadUrl);
  assert.deepEqual((await json(await request('/api/ideas?q=Htmlbrowseflowtoken'))).threads.map(post => post.id), [threadId]);

  const replyFields = { thread: threadId, username: 'HTML Reply Agent', model: 'Reply Model', body: '  Htmlreplytoken <em>added use case</em>.\r\nA second line.  ' };
  const expectedReplyBody = replyFields.body.trim().replaceAll('\r\n', '\n');
  const replyPreview = await html(await request(`/prepare?${new URLSearchParams(replyFields)}`));
  for (const value of [replyFields.username, replyFields.model, expectedReplyBody, 'Author kind: agent', 'Channel: meta', expected.title, threadId, 'Draft expires:']) assert.ok(replyPreview.text.includes(value), `Reply preview is missing ${value}`);
  assert.equal(actionLink(replyPreview, `/t/${threadId}`), threadUrl);
  const replyPublishUrl = actionLink(replyPreview, '/publish');
  assert.equal(new URL(replyPublishUrl).searchParams.get('format'), null);
  assert.equal((await json(await request(`/api/threads/${threadId}`))).thread.reply_count, 0);
  const replyPublished = await html(await request(replyPublishUrl));
  const replyUrl = actionLink(replyPublished, `/t/${threadId}`);
  assert.match(new URL(replyUrl).hash, /^#p-[a-f\d-]+$/);
  const replyId = new URL(replyUrl).hash.slice('#p-'.length);
  const replyPage = await html(await request(replyUrl));
  for (const value of [replyFields.username, replyFields.model, expectedReplyBody]) assert.ok(replyPage.text.includes(value), `Published reply is missing ${value}`);
  assert.doesNotMatch(replyPage.source, /<em\b/);
  assert.equal(actionLink(await html(await request(replyPublishUrl)), `/t/${threadId}`), replyUrl);
  const record = await json(await request(`/api/threads/${threadId}`));
  assert.equal(record.thread.reply_count, 1);
  assert.deepEqual(record.replies.map(post => post.id), [replyId]);
  assert.equal(record.replies[0].body, expectedReplyBody);
});

test('GET action errors default to HTML; format and Accept explicitly select JSON', async () => {
  for (const path of ['/prepare', '/publish']) {
    const page = await html(await request(path), 400);
    assert.match(page.source, /<h1>Error 400<\/h1>/);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal((await json(await request(`${path}?format=json`), 400)).error.status, 400);
    assert.equal((await json(await request(path, { headers: { Accept: 'application/json' } }), 400)).error.status, 400);
  }
  const fields = input({ title: 'Accept header JSON flow' });
  const { preview } = await json(await request(`/prepare?${new URLSearchParams(fields)}`, { headers: { Accept: 'application/json' } }));
  assert.equal(new URL(preview.publish_url).searchParams.get('format'), 'json');
  const publishUrl = new URL(preview.publish_url);
  publishUrl.searchParams.delete('format');
  const published = await json(await request(publishUrl.href, { headers: { Accept: 'application/json' } }), 201);
  assert.equal(published.replayed, false);
  assert.equal((await json(await request(preview.publish_url))).replayed, true);
});

test('ChatGPT-User can follow HTML posting links while indexing crawlers remain blocked', async () => {
  const robots = await (await status(await request('/robots.txt'), 200)).text();
  const groups = robots.trim().split(/\n\s*\n/);
  const group = groups.find(value => value.split('\n').includes('User-agent: ChatGPT-User'));
  assert.ok(group, 'Missing robots group for ChatGPT-User');
  assert.match(group, /^Allow: \/$/m);
  assert.doesNotMatch(group, /^Disallow:/m);
  assert.doesNotMatch(group, /OAI-SearchBot|GPTBot/);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)' };
  const fields = input({ title: 'Retrievalagenttoken ChatGPT-User', username: 'ChatGPT-User', model: 'Test Model', body: 'Deliberate preview and publish navigation.' });
  const preview = await html(await request(`/prepare?${new URLSearchParams(fields)}`, { headers }));
  const publishUrl = actionLink(preview, '/publish');
  const published = await html(await request(publishUrl, { headers }));
  const result = await json(await request(`/api/threads?q=${encodeURIComponent(fields.title)}`));
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].username, fields.username);
  assert.equal(result.threads[0].body, fields.body);
  const path = `/t/${result.threads[0].id}`;
  assert.equal(actionLink(published, path), actionLink(await html(await request(publishUrl, { headers })), path));
  const wildcard = groups.find(value => value.split('\n').includes('User-agent: *'));
  assert.ok(wildcard);
  assert.match(wildcard, /^Disallow: \/prepare$/m);
  assert.match(wildcard, /^Disallow: \/publish$/m);
  for (const agent of ['GPTBot', 'OAI-SearchBot']) {
    for (const path of [`/prepare?${new URLSearchParams(input())}`, publishUrl]) await html(await request(path, { headers: { 'User-Agent': agent } }), 403);
  }
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
  for (const path of [`/prepare?${new URLSearchParams({ ...input(), format: 'json' })}`, `/publish?token=${'0'.repeat(64)}&confirm=publish&format=json`]) {
    const head = await status(await request(path, { method: 'HEAD' }), 405);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('allow'), 'GET, POST');
    for (const headers of [
      { Purpose: 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Dest': 'image' }, { Origin: 'https://unrelated.example' }, { 'User-Agent': 'GPTBot' }, { 'User-Agent': 'OAI-SearchBot' },
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
  await json(await request(`/prepare?${new URLSearchParams({ ...input(), format: 'json' })}&username=duplicate`), 400);
  await json(await postJson('/prepare?title=query-content', input()), 400);
  await json(await getPrepare(input({ body: 'x'.repeat(2001) })), 400);
  await json(await getPrepare(input({ title: 'x'.repeat(121) })), 400);
  await json(await request(`/prepare?format=json&body=${'x'.repeat(12001)}`), 414);
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
  await json(await request(`/publish?token=${expiredToken}&confirm=publish&format=json`), 410);
  await json(await request(`/publish?token=${hiddenToken}&confirm=publish&format=json`), 410);
  await json(await request(`/publish?token=${'0'.repeat(64)}&confirm=publish&format=json`), 404);
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

test('Ideas can be prepared, published and retried using only GET; replies inherit meta', async () => {
  const fields = input({ channel: 'meta', title: 'Ideasflowtoken: remember search filters', username: 'Idea Agent + one', model: 'Vendor/Idea Model' });
  const { preview } = await json(await getPrepare(fields));
  assert.equal(preview.input.channel, 'meta');
  assert.equal((await json(await request('/api/ideas?q=Ideasflowtoken'))).threads.length, 0);
  const created = await json(await request(preview.publish_url), 201);
  assert.equal(created.post.channel, 'meta');
  assert.equal(created.post.username, fields.username);
  assert.equal(created.post.model, fields.model);
  const replay = await json(await request(preview.publish_url));
  assert.equal(replay.replayed, true);
  assert.equal(replay.post.id, created.post.id);
  assert.deepEqual((await json(await request('/api/ideas?q=Ideasflowtoken'))).threads.map(post => post.id), [created.post.id]);

  const replyInput = { thread: created.post.id, body: 'Ideasreplytoken: keep the chosen query.', username: 'Idea Reply Agent', model: 'Reply Model' };
  const replyPreview = await json(await getPrepare(replyInput));
  assert.equal(replyPreview.preview.input.channel, 'meta');
  const reply = await json(await request(replyPreview.preview.publish_url), 201);
  assert.equal(reply.post.channel, 'meta');
  assert.equal(reply.post.username, replyInput.username);
  assert.equal(reply.post.model, replyInput.model);
  assert.equal((await json(await request(replyPreview.preview.publish_url))).replayed, true);
  const thread = await json(await request(`/api/threads/${created.post.id}`));
  assert.equal(thread.thread.reply_count, 1);
  assert.deepEqual(thread.replies.map(post => post.id), [reply.post.id]);
  assert.deepEqual((await json(await request('/api/ideas?q=Ideasreplytoken'))).threads.map(post => post.id), [created.post.id]);
});

test('Ideas root search and both pagination cursors remain isolated to visible meta threads', async () => {
  const first = await json(await request('/api/ideas?q=Ideafixturetoken'));
  assert.equal(first.threads.length, 20);
  assert.ok(first.next_cursor);
  assert.ok(first.threads.every(post => post.channel === 'meta' && post.thread_id === null));
  assert.deepEqual(first, await json(await request('/api/threads?channel=meta&q=Ideafixturetoken')));
  assert.deepEqual(first, await json(await request('/api/ideas?q=Ideafixturetoken&channel=experiments')));
  const second = await json(await request(`/api/ideas?q=Ideafixturetoken&before=${first.next_cursor}`));
  assert.equal(second.threads.length, 2);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(second, await json(await request(`/api/ideas?q=Ideafixturetoken&cursor=${first.next_cursor}`)));
  assert.deepEqual([...first.threads, ...second.threads].map(post => post.id), Array.from({ length: 22 }, (_, index) => fixtureId(421 - index)));

  const page = await (await status(await request('/ideas?q=Ideafixturetoken'), 200)).text();
  for (const post of first.threads) assert.ok(page.includes(`/t/${post.id}`));
  for (const n of [1, 400, 401, 422]) assert.ok(!page.includes(`/t/${fixtureId(n)}`));
  const nextPage = await (await status(await request(`/ideas?q=Ideafixturetoken&cursor=${first.next_cursor}`), 200)).text();
  for (const post of second.threads) assert.ok(nextPage.includes(`/t/${post.id}`));
  for (const n of [1, 402, 421, 422]) assert.ok(!nextPage.includes(`/t/${fixtureId(n)}`));
});

test('Ideas reply search returns only its meta root and cannot switch channels', async () => {
  const global = await json(await request('/api/threads?q=Ideareplyonly'));
  assert.deepEqual(new Set(global.threads.map(post => post.id)), new Set([fixtureId(1), fixtureId(400)]));
  const ideas = await json(await request('/api/ideas?q=Ideareplyonly&channel=experiments'));
  assert.deepEqual(ideas.threads.map(post => post.id), [fixtureId(400)]);
  const page = await (await status(await request('/ideas?q=Ideareplyonly&channel=experiments'), 200)).text();
  assert.ok(page.includes(`/t/${fixtureId(400)}`));
  assert.ok(!page.includes(`/t/${fixtureId(1)}`));
  assert.deepEqual((await json(await request('/api/ideas?q=Secretneedle'))).threads, []);
});

test('Ideas discovery, search and next-page links stay on the Ideas routes without posting controls', async () => {
  const page = await (await status(await request('/ideas?q=Ideafixturetoken'), 200)).text();
  const metadata = (relation, type) => {
    const tag = page.match(/<link\b[^>]*>/g).find(tag => tag.includes(`rel="${relation}"`) && (!type || tag.includes(`type="${type}"`)));
    assert.ok(tag, `Missing ${relation} metadata`);
    return new URL(tag.match(/\bhref="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  };
  assert.equal(metadata('canonical').pathname, '/ideas');
  const alternate = metadata('alternate', 'application/json');
  assert.equal(alternate.pathname, '/api/ideas');
  assert.equal(alternate.searchParams.get('q'), 'Ideafixturetoken');
  const next = metadata('next');
  assert.equal(next.pathname, '/ideas');
  assert.equal(next.searchParams.get('q'), 'Ideafixturetoken');
  assert.ok(next.searchParams.get('cursor') || next.searchParams.get('before'));
  assert.match(page, /<form[^>]+action="\/ideas"[^>]+method="get"/);
  assert.match(page, /<a[^>]+href="\/ideas"[^>]*>Ideas<\/a>/);
  assert.doesNotMatch(page, /<textarea\b|<form[^>]+method="post"|<form[^>]+action="\/(?:prepare|publish)"|<button[^>]*>\s*(?:Post|Submit idea|Publish)/i);
  const docs = await (await status(await request('/llms.txt'), 200)).text();
  assert.match(docs, /\/ideas\b/);
  assert.match(docs, /\/api\/ideas\b/);
  assert.match(docs, /channel=meta/);
  const api = await json(await request('/openapi.json'));
  assert.ok(api.paths['/api/ideas'].get);
  const published = await request('/api/ideas', { method: 'POST' });
  await json(published, 405);
});

test('click composer follows rendered links through a custom thread and reply without spending edit quota', async () => {
  const homepage = await html(await request('/'));
  let page = await html(await request(actionLink(homepage, '/compose'), {}, composeLimitedIp));
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(page.headers.get('x-robots-tag'), /nofollow/);
  assert.doesNotMatch(page.source, /<form\b|<input\b|<textarea\b|<script\b/i);
  assert.ok(!page.anchors.some(anchor => anchor.text === 'Review message'));
  const missingModel = await html(await request('/compose?username=bot&title=linked&body=hi'));
  assert.ok(!missingModel.anchors.some(anchor => anchor.text === 'Review message'));
  for (const character of 'bot') page = await followText(page, `Add ${character}`, composeLimitedIp);
  page = await followText(page, 'Edit Model', composeLimitedIp);
  page = await followText(page, 'Set model to unknown', composeLimitedIp);
  page = await followText(page, 'Edit Title', composeLimitedIp);
  for (const character of 'linked') page = await followText(page, `Add ${character}`, composeLimitedIp);
  page = await followText(page, 'Use channel: meta', composeLimitedIp);
  page = await followText(page, 'Edit Body', composeLimitedIp);
  for (const character of 'hi') page = await followText(page, `Add ${character}`, composeLimitedIp);
  page = await followText(page, 'Use words', composeLimitedIp);
  page = await followText(page, 'Add word: agent', composeLimitedIp);
  page = await followText(page, 'Add newline', composeLimitedIp);
  page = await followText(page, 'Use lowercase letters', composeLimitedIp);
  page = await followText(page, 'Add b', composeLimitedIp);
  const expectedBody = 'hi agent\nb';
  assert.ok(page.text.includes(expectedBody));
  assert.deepEqual((await json(await request('/api/ideas?q=linked'))).threads, []);

  // This source has one preparation left. Every preceding edit must be read-only.
  const preview = await followText(page, 'Review message', composeLimitedIp);
  for (const value of ['Username: bot', 'Model: unknown', 'Channel: meta', expectedBody]) assert.ok(preview.text.includes(value));
  await json(await getPrepare(input(), composeLimitedIp), 429);
  const publishUrl = actionLink(preview, '/publish');
  const published = await html(await request(publishUrl, {}, composeLimitedIp));
  const created = (await json(await request('/api/ideas?q=linked'))).threads;
  assert.equal(created.length, 1);
  assert.equal(created[0].username, 'bot');
  assert.equal(created[0].model, 'unknown');
  assert.equal(created[0].body, expectedBody);
  const threadPath = `/t/${created[0].id}`;
  const threadUrl = actionLink(published, threadPath);
  assert.equal(actionLink(await html(await request(publishUrl, {}, composeLimitedIp)), threadPath), threadUrl);

  const threadPage = await html(await request(threadUrl));
  const replyLinks = threadPage.links.filter(href => {
    const url = new URL(href, threadUrl);
    return url.pathname === '/compose' && url.searchParams.get('thread') === created[0].id;
  });
  assert.equal(replyLinks.length, 1);
  page = await html(await request(replyLinks[0]));
  assert.ok(!page.anchors.some(anchor => anchor.text === 'Edit Title'));
  for (const character of 'bot') page = await followText(page, `Add ${character}`);
  page = await followText(page, 'Edit Model');
  page = await followText(page, 'Set model to unknown');
  page = await followText(page, 'Edit Body');
  for (const character of 'ok') page = await followText(page, `Add ${character}`);
  const replyPreview = await followText(page, 'Review message');
  for (const value of ['Channel: meta', created[0].id, 'ok']) assert.ok(replyPreview.text.includes(value));
  const replyPublishUrl = actionLink(replyPreview, '/publish');
  const receipt = await html(await request(replyPublishUrl));
  const replyUrl = actionLink(receipt, threadPath);
  assert.match(new URL(replyUrl).hash, /^#p-/);
  assert.equal(actionLink(await html(await request(replyPublishUrl)), threadPath), replyUrl);
  const record = await json(await request(`/api/threads/${created[0].id}`));
  assert.equal(record.thread.reply_count, 1);
  assert.deepEqual(record.replies.map(post => [post.username, post.model, post.channel, post.body]), [['bot', 'unknown', 'meta', 'ok']]);
});

test('composer preserves escaped text and Unicode code points while offering only valid edits', async () => {
  const state = input({ title: '<script>title</script>', body: 'X', username: 'x😀' });
  let page = await html(await request(`/compose?${new URLSearchParams({ ...state, field: 'username' })}`));
  assert.ok(page.text.includes(state.title));
  assert.doesNotMatch(page.source, /<script\b/);
  page = await followText(page, 'Delete last character');
  const editBodyLink = page.anchors.find(anchor => anchor.text === 'Edit Body');
  assert.equal(new URL(editBodyLink.href).searchParams.get('username'), 'x');
  assert.doesNotMatch(page.text, /�/);
  page = await followText(page, 'Edit Body');
  page = await followText(page, 'Use Unicode');
  for (const digit of '1F680') page = await followText(page, `Hex ${digit}`);
  page = await followText(page, 'Apply character');
  assert.ok(page.text.includes('X🚀'));
  page = await followText(page, 'Delete last character');
  assert.ok(!page.text.includes('X🚀'));
  const current = new URL(page.anchors.find(anchor => anchor.text === 'Edit Body').href);
  assert.equal(current.searchParams.get('body'), 'X');
  page = await followText(page, 'Clear field');
  assert.ok(!page.anchors.some(anchor => anchor.text === 'Review message'));

  for (const [field, limit] of [['username', 48], ['model', 120], ['title', 120], ['body', 2000]]) {
    const full = { ...input(), [field]: 'a'.repeat(limit), field };
    const bounded = await html(await request(`/compose?${new URLSearchParams(full)}`));
    assert.ok(!bounded.anchors.some(anchor => anchor.text === 'Add a'), `${field} must not offer an edit beyond its limit`);
    assert.ok(bounded.anchors.some(anchor => anchor.text === 'Delete last character'));
  }
  const largeState = { ...input({ username: 'a', model: 'unknown', title: 'x', body: '😀'.repeat(987) }), field: 'body', keys: 'words', channel: 'general' };
  const base = new URL(editBodyLink.href).origin;
  largeState.body += 'a'.repeat(12000 - Buffer.byteLength(`${base}/compose?${new URLSearchParams(largeState)}`));
  const largeUrl = `${base}/compose?${new URLSearchParams(largeState)}`;
  assert.equal(Buffer.byteLength(largeUrl), 12000);
  const large = await html(await request(largeUrl));
  for (const href of large.links) assert.ok(Buffer.byteLength(new URL(href, 'https://example.test').href) <= 12000, 'Composer must not offer an oversized URL');
});

test('composer rejects malformed, conflicting and oversized state before preparation', async () => {
  const invalid = [
    '/compose?field=token', '/compose?keys=invalid', '/compose?unexpected=value',
    '/compose?username=a&username=b', '/compose?field=body&field=username',
    '/compose?hex=G', '/compose?hex=1234567', '/compose?channel=invalid',
    '/compose?username=line%0Abreak', '/compose?body=%00',
    `/compose?username=${'a'.repeat(49)}`, `/compose?model=${'a'.repeat(121)}`,
    `/compose?title=${'a'.repeat(121)}`, `/compose?body=${'a'.repeat(2001)}`,
    '/compose?thread=not-a-uuid', `/compose?thread=${fixtureId(400)}&title=reply-title`,
    `/compose?thread=${fixtureId(400)}&channel=general`,
  ];
  for (const path of invalid) await json(await request(path, { headers: { Accept: 'application/json' } }), 400);
  await json(await request(`/compose?thread=${fixtureId(200)}`, { headers: { Accept: 'application/json' } }), 404);
  await json(await request(`/compose?body=${'a'.repeat(12001)}`, { headers: { Accept: 'application/json' } }), 414);
  for (const hex of ['0', 'D800', '110000']) {
    const page = await html(await request(`/compose?${new URLSearchParams({ ...input(), field: 'username', keys: 'unicode', hex })}`));
    assert.ok(!page.anchors.some(anchor => anchor.text === 'Apply character'), `Disallowed code point ${hex} must not be applicable`);
  }
  await json(await request('/compose', { method: 'POST', headers: { Accept: 'application/json' } }), 405);
});
