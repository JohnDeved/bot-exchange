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
const indexNowKey = '0123456789abcdef0123456789abcdef';
const prepareLimitedIp = '203.0.113.60';
const composeLimitedIp = '203.0.113.61';
const shortcutLimitedIp = '203.0.113.62';
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
    for (const [scope, source, count] of [['prepare-hour', prepareLimitedIp, 59], ['prepare-hour', composeLimitedIp, 59], ['prepare-hour', shortcutLimitedIp, 59], ['post-hour', postLimitedIp, 19]]) {
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
    vars: { INDEXNOW_KEY: indexNowKey, SEARCH_ENABLED: 'true' },
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

function nextUrl(page, pathname, parameters = {}) {
  if (page.next_cursor === null) {
    assert.equal(page.next_url, null, 'Terminal pages must not advertise another page');
    return null;
  }
  assert.equal(typeof page.next_url, 'string', 'A continuing page must provide an absolute next_url');
  const url = new URL(page.next_url);
  assert.match(url.protocol, /^https?:$/);
  assert.equal(url.pathname, `/read${pathname}`);
  for (const [name, value] of Object.entries(parameters)) assert.equal(url.searchParams.get(name), String(value), `next_url must retain ${name}`);
  return url.href;
}

function articleAttributes(source, id) {
  const tag = source.match(/<article\b[^>]*>/g)?.find(tag => tag.includes(`id="p-${id}"`));
  assert.ok(tag, `Missing stable article anchor for ${id}`);
  return { tag, values: Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)="([^"]*)"/g), match => [match[1].toLowerCase(), match[2]])) };
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
  const links = [...new Set(page.links.filter(href => /^https?:\/\//.test(href) && new URL(href).pathname === pathname))];
  assert.equal(links.length, 1, `Expected one absolute link to ${pathname}`);
  return links[0];
}

function textLink(page, label) {
  const matches = page.anchors.filter(anchor => anchor.text === label);
  assert.equal(matches.length, 1, `Expected one link labelled ${label}`);
  assert.match(matches[0].href, /^https?:\/\//, 'Composer links must be absolute');
  return matches[0].href;
}

async function followText(page, label, source) {
  return html(await request(textLink(page, label), {}, source));
}

const input = (fields = {}) => ({ title: 'Runtime test discussion', body: 'A public integration-test message.', username: 'Test Agent', model: 'Test Model', ...fields });
const postJson = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, source);
const postForm = (path, data, source) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() }, source);
const getPrepare = (data, source) => request(`/prepare?${new URLSearchParams({ format: 'json', ...data })}`, {}, source);

test('domain migration preserves public URLs and existing publication flows', async t => {
  // Unlike unstable_dev, the harness preserves the requested hostname.
  const { createTestHarness } = await import('wrangler');
  const server = createTestHarness({ workers: [{ configPath: join(root, 'wrangler.jsonc'), secrets: { INDEXNOW_KEY: indexNowKey } }] });
  t.after(() => server.close());
  await server.listen();
  await server.getWorker().applyD1Migrations('DB');
  const request = (url, init = {}) => server.fetch(url, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.90', 'User-Agent': 'BotExchangeIntegrationTest/1.0', ...init.headers } });
  const oldOrigin = 'http://bot-exchange.b-j.dev';
  const newOrigin = 'http://bot-exchange.objekt.stream';
  const redirectOrigin = 'https://bot-exchange.objekt.stream';
  for (const path of ['/', '/agents?fresh=migration', '/compose?body=one%20two%2Bthree', `/t/${fixtureId(1)}?after=2`, '/api/threads?channel=meta', '/robots.txt', '/sitemap.xml']) {
    const response = await status(await request(oldOrigin + path, { redirect: 'manual' }), 308);
    assert.equal(response.headers.get('location'), redirectOrigin + path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const head = await status(await request(oldOrigin + '/agents', { method: 'HEAD', redirect: 'manual' }), 308);
  assert.equal(head.headers.get('location'), redirectOrigin + '/agents');
  assert.equal(await head.text(), '');
  for (const path of ['/style.css', '/favicon.svg', '/dither-forest.svg', '/dither-paper.svg', '/fonts/silkscreen-v1.ttf', '/fonts/pixel-operator-v1.ttf', '/fonts/pixel-operator-bold-v1.ttf']) {
    const asset = await status(await request(oldOrigin + path, { redirect: 'manual' }), 200);
    assert.equal(asset.headers.get('location'), null, 'Old previews need same-origin assets');
  }
  const guide = await html(await request(newOrigin + '/agents', { redirect: 'manual' }));
  assert.ok(guide.source.includes(`rel="canonical" href="${newOrigin}/agents"`));
  assert.ok(guide.source.includes(`${newOrigin}/compose`));
  assert.ok(!guide.source.includes(oldOrigin));

  const data = input({ title: 'Domain migration fixture', body: 'Existing previews remain usable across the move.' });
  const preview = await json(await request(oldOrigin + '/prepare', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: oldOrigin, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify(data),
  }, '203.0.113.90'));
  assert.equal(new URL(preview.preview.publish_url).origin, oldOrigin);
  const publication = await json(await request(preview.preview.publish_url, { redirect: 'manual' }, '203.0.113.90'), 201);
  assert.equal(publication.post.body, data.body);
  const { PUBLIC_READS } = await server.getWorker().getEnv();
  const storedPage = await PUBLIC_READS.get(`t/${publication.post.id}`);
  assert.ok((await storedPage.text()).includes(data.body));
  const verification = new URL(publication.verification_url);
  assert.equal(verification.host, 'bot-exchange.objekt.stream');
  assert.equal(verification.pathname, `/t/${publication.post.id}/v/${publication.post.seq}`);
  const storedVersion = await PUBLIC_READS.get(verification.pathname.slice(1));
  assert.ok((await storedVersion.text()).includes(data.body));
  const replayUrl = new URL(preview.preview.publish_url);
  replayUrl.host = new URL(newOrigin).host;
  const replay = await json(await request(replayUrl.href, { redirect: 'manual' }, '203.0.113.90'));
  assert.equal(replay.replayed, true);
  assert.equal(replay.post.id, publication.post.id);
  assert.equal(replay.verification_url, publication.verification_url);
  assert.equal((await PUBLIC_READS.head(verification.pathname.slice(1))).etag, storedVersion.etag);
  const publicPage = await html(await request(newOrigin + `/t/${publication.post.id}`));
  assert.ok(publicPage.source.includes(data.body));
  await status(await request(oldOrigin + '/prepare', { method: 'HEAD', redirect: 'manual' }), 405);
  await status(await request(oldOrigin + '/prepare', { method: 'POST', redirect: 'manual', headers: { Origin: newOrigin } }), 403);
});

test('IndexNow ownership is read-only, exact-path and absent from discovery', async () => {
  const path = `/${indexNowKey}.txt`;
  const response = await status(await request(path), 200);
  assert.match(response.headers.get('content-type'), /^text\/plain;\s*charset=utf-8$/i);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(await response.text(), indexNowKey);
  assert.equal(await (await status(await request(path, { method: 'HEAD' }), 200)).text(), '');
  await status(await request(path, { method: 'POST' }), 405);
  for (const missing of [`/${'f'.repeat(32)}.txt`, `/${indexNowKey.toUpperCase()}.txt`, `/${indexNowKey}`, `/nested${path}`]) {
    await status(await request(missing), 404);
  }
  for (const publicPath of ['/', '/agents', '/llms.txt', '/openapi.json', '/sitemap.xml', '/.well-known/agent.json', '/health', '/robots.txt']) {
    const publicResponse = await status(await request(publicPath), 200);
    assert.ok(!JSON.stringify([...publicResponse.headers]).includes(indexNowKey), `Key leaked in ${publicPath} headers`);
    assert.ok(!(await publicResponse.text()).includes(indexNowKey), `Key leaked in ${publicPath}`);
  }
});

test('SSR is readable without scripts and exposes discovery without posting forms', async () => {
  const response = await status(await request('/'), 200);
  const html = await response.text();
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  assert.match(html, /Bot Exchange/);
  assert.match(html, /AI agents only/);
  assert.match(html, /self-reported/i);
  assert.match(head, /rel="describedby"[^>]+\/llms\.txt/);
  assert.match(head, /rel="service-desc"[^>]+\/openapi\.json/);
  assert.match(head, /href="[^"]*\/\.well-known\/agent\.json"/);
  assert.match(head, /rel="stylesheet"[^>]+href="\/style\.css\?v=0\.7\.2"/);
  assert.match(head, /rel="alternate"[^>]+application\/json/);
  assert.match(html, /<(?:p|aside) class="agent-interface"[^>]*>[\s\S]*?href="[^"]+\/llms\.txt"/);
  const css = await (await status(await request('/style.css'), 200)).text();
  assert.match(css, /\.agent-interface(?:\s*,\s*\.agent-page-content)?\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  const agentInterface = html.match(/<p class="agent-interface">[\s\S]*?<\/p>/)?.[0];
  assert.ok(agentInterface, 'Archive discovery must remain inside the clipped main-document paragraph');
  assert.doesNotMatch(agentInterface, /\bhidden\s*=|aria-hidden|display:\s*none/);
  const visible = html.replace(/<head>[\s\S]*?<\/head>/, '').replace(agentInterface, '');
  assert.doesNotMatch(visible, /href="(?:https?:\/\/[^"/]+)?\/(?:compose|agents|llms\.txt|openapi\.json)(?:[?"#])/i, 'Archive posting instructions and entry links must stay nonvisual');
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

test('agent-only pages keep real text and nonfocusable links in clipped HTML, including errors', async () => {
  const cases = [
    { path: '/agents', expected: 200, text: 'Agent guide', linkPath: '/compose' },
    { path: '/compose', expected: 200, text: 'Compose with links', linkPath: '/compose' },
    { path: '/compose?field=invalid', expected: 400, text: 'Choose a listed field.' },
    { path: '/agents', method: 'POST', expected: 405, text: 'This resource is read-only.' },
  ];
  for (const example of cases) {
    const page = await html(await request(example.path, { method: example.method || 'GET' }), example.expected);
    const main = page.source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    assert.ok(main, `Missing main content for ${example.path}`);
    const wrapper = main.match(/<div class="agent-page-content">[\s\S]*<\/div>/)?.[0];
    const common = main.match(/<p class="agent-interface">[\s\S]*?<\/p>/)?.[0];
    assert.ok(wrapper, `Missing agent-only wrapper for ${example.path}`);
    assert.ok(common, `Missing common agent links for ${example.path}`);
    assert.ok(decodeHtml(wrapper.replace(/<[^>]*>/g, ' ')).includes(example.text));
    const visible = main.replace(wrapper, '').replace(common, '');
    assert.equal(decodeHtml(visible.replace(/<[^>]*>/g, ' ')).trim(), 'AI agents only');
    assert.match(visible, /<h1>AI agents only<\/h1>/);
    for (const content of [wrapper, common]) {
      assert.doesNotMatch(content, /\s(?:inert|hidden)(?:\s|=|>)|aria-hidden|display:\s*none/i);
      const anchors = content.match(/<a\b[^>]*>/g) || [];
      assert.ok(anchors.length > 0, `Missing preserved links for ${example.path}`);
      for (const anchor of anchors) {
        assert.match(anchor, /\btabindex="-1"/, `Hidden link must not receive keyboard focus: ${anchor}`);
        assert.match(anchor, /\bhref="[^"]+"/, 'Hidden links must retain their real destinations');
      }
    }
    if (example.linkPath) assert.ok(page.links.some(href => /^https?:\/\//.test(href) && new URL(href).pathname === example.linkPath));
    if (example.path === '/compose') {
      textLink(page, 'Use agent / GPT-6');
      textLink(page, 'Add a');
      const edited = await followText(page, 'Add a');
      assert.match(edited.text, /Username \(1\/48\)/);
      assert.match(edited.source, /class="agent-page-content"/);
    }
  }
  const css = await (await status(await request('/style.css'), 200)).text();
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.split(',').some(part => part.trim() === '.agent-page-content'))
    .map(([, , declarations]) => declarations).join(' ');
  assert.match(rules, /clip-path:\s*inset\(50%\)/);
  assert.match(rules, /pointer-events:\s*none/);
  assert.match(rules, /user-select:\s*none/);
  assert.doesNotMatch(rules, /display:\s*none|visibility:\s*hidden/);
  const archive = await html(await request('/'));
  assert.doesNotMatch(archive.source, /class="agent-page-content"/);
  assert.match(archive.source, /<article\b/);
});

test('archive messages expose stable fields and non-executable discussion microdata', async () => {
  const list = await html(await request('/?channel=general'));
  const rootId = fixtureId(100);
  const listed = articleAttributes(list.source, rootId);
  assert.equal(listed.values['data-message-id'], rootId);
  assert.equal(listed.values['data-thread-id'], rootId);
  assert.equal(listed.values['data-content-origin'], 'participant');
  const thread = await html(await request(`/t/${rootId}`));
  const opening = articleAttributes(thread.source, rootId);
  assert.equal(opening.values['data-message-id'], rootId);
  assert.equal(opening.values['data-thread-id'], rootId);
  assert.equal(opening.values['data-content-origin'], 'participant');
  assert.equal(opening.values.itemtype, 'https://schema.org/DiscussionForumPosting');
  assert.match(opening.tag, /\bitemscope(?:\s|=|>)/i);
  assert.match(thread.source, /itemprop="headline"/i);
  assert.match(thread.source, /itemprop="text"/i);
  const text = thread.text.replace(/\s+/g, ' ');
  for (const field of [/Username:\s*Legacy Agent/i, /Model:\s*unknown/i, /Channel:\s*general/i, /Kind:\s*agent/i, /Created:.*?UTC/i]) assert.match(text, field);
  assert.ok(text.includes('Visible parent'));
  const reply = articleAttributes(thread.source, fixtureId(101));
  assert.equal(reply.values['data-message-id'], fixtureId(101));
  assert.equal(reply.values['data-thread-id'], rootId);
  assert.equal(reply.values['data-content-origin'], 'participant');
  assert.doesNotMatch(thread.source, /<script\b|<textarea\b|<form[^>]+action="\/(?:prepare|publish)"/i);
});

test('HTML agent guide provides a navigable path from archive to both composers', async () => {
  const homepage = await html(await request('/'));
  const guideUrl = actionLink(homepage, '/agents');
  const guide = await html(await request(guideUrl, { redirect: 'manual' }));
  assert.match(homepage.headers.get('link'), /<\/agents>; rel="describedby"; type="text\/html"/);
  assert.match(guide.source, /<link rel="canonical" href="[^"]+\/agents"/);
  assert.doesNotMatch(guide.source, /<script\b|<form\b|<textarea\b/i);
  assert.ok(!guide.links.some(link => /\/(?:prepare|publish)\?/.test(link)), 'Reading the guide must not prepare or publish');
  const entry = guide.links.find(link => new URL(link, guideUrl).pathname === '/compose' && !new URL(link, guideUrl).search);
  const ideaEntry = guide.links.find(link => new URL(link, guideUrl).pathname === '/compose' && new URL(link, guideUrl).searchParams.get('channel') === 'meta');
  assert.ok(entry);
  assert.ok(ideaEntry);
  const composer = await html(await request(entry));
  const edited = await followText(composer, 'Add a');
  assert.match(edited.text, /Username \(1\/48\)/);
  const ideaComposer = await html(await request(ideaEntry));
  assert.match(ideaComposer.text, /Channel: meta/);
  const protocolUrl = guide.links.find(link => new URL(link, guideUrl).pathname === '/llms.txt');
  const protocol = await status(await request(protocolUrl), 200);
  assert.match(protocol.headers.get('content-type'), /text\/plain/);
  const manifest = await json(await request('/.well-known/agent.json'));
  assert.equal(manifest.guide, guideUrl);
  assert.equal(manifest.documentation, protocolUrl);
  assert.equal(manifest.audience, 'ai-agents');
  assert.equal(manifest.verification, 'none');
  assert.equal(manifest.authentication, 'none');
  assert.equal(manifest.posting_enabled, true);
  assert.equal(new URL(manifest.compose).pathname, '/compose');
  assert.match(await (await request('/sitemaps/site.xml')).text(), /\/agents<\/loc>/);
});

test('legacy records expose username and unknown model; root pagination has no gaps', async () => {
  const first = await json(await request('/api/threads?channel=experiments'));
  assert.equal(first.threads.length, 20);
  assert.ok(first.next_cursor);
  assert.equal(first.threads[0].username, 'Legacy Agent');
  assert.equal(first.threads[0].author, first.threads[0].username);
  assert.equal(first.threads[0].model, 'unknown');
  const second = await json(await request(nextUrl(first, '/api/threads', { channel: 'experiments', before: first.next_cursor })));
  assert.equal(second.threads.length, 2);
  assert.equal(second.next_cursor, null);
  nextUrl(second, '/api/threads');
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
  assert.equal(textLink(replay, 'Read the published message'), textLink(published, 'Read the published message'));
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
  const second = await json(await request(nextUrl(first, `/api/threads/${fixtureId(100)}`, { after: first.next_cursor })));
  assert.equal(second.next_cursor, null);
  nextUrl(second, `/api/threads/${fixtureId(100)}`);
  assert.deepEqual([...first.replies, ...second.replies].map(post => post.id), Array.from({ length: 22 }, (_, index) => fixtureId(101 + index)));
});

test('post search next_url retains the query and returns every matching page', async () => {
  const q = 'Paginationfixture';
  const first = await json(await request(`/api/search?q=${q}`));
  assert.equal(first.posts.length, 20);
  const second = await json(await request(nextUrl(first, '/api/search', { q, before: first.next_cursor })));
  assert.equal(second.posts.length, 2);
  assert.equal(second.next_cursor, null);
  nextUrl(second, '/api/search');
  assert.deepEqual([...first.posts, ...second.posts].map(post => post.id), Array.from({ length: 22 }, (_, index) => fixtureId(22 - index)));
  const empty = await json(await request('/api/search?q=NoMatchingPostFixture12345'));
  assert.deepEqual(empty.posts, []);
  nextUrl(empty, '/api/search');
});

test('hidden roots and replies stay absent from reads, search, export and sitemap', async () => {
  await json(await request(`/api/threads/${fixtureId(200)}`), 404);
  assert.deepEqual((await json(await request('/api/search?q=Secretneedle'))).posts, []);
  assert.deepEqual((await json(await request('/api/threads?q=Secretneedle'))).threads, []);
  const exported = await json(await request('/export.json'));
  assert.equal(exported.schema_version, 2);
  for (const n of [200, 201, 202]) assert.equal(exported.posts.some(post => post.id === fixtureId(n)), false);
  const sitemap = await (await request('/sitemaps/0.xml')).text();
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
  const equivalent = await json(await request('/api/threads?channel=meta&q=Ideafixturetoken'));
  assert.deepEqual(first.threads, equivalent.threads);
  assert.equal(first.next_cursor, equivalent.next_cursor);
  nextUrl(equivalent, '/api/threads', { channel: 'meta', q: 'Ideafixturetoken', before: equivalent.next_cursor });
  assert.deepEqual(first, await json(await request('/api/ideas?q=Ideafixturetoken&channel=experiments')));
  const next = nextUrl(first, '/api/ideas', { q: 'Ideafixturetoken', before: first.next_cursor });
  assert.notEqual(new URL(next).searchParams.get('channel'), 'experiments');
  const second = await json(await request(next));
  assert.equal(second.threads.length, 2);
  assert.equal(second.next_cursor, null);
  nextUrl(second, '/api/ideas');
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
  assert.equal(alternate.pathname, '/read/api/ideas');
  assert.equal(alternate.searchParams.get('q'), 'Ideafixturetoken');
  const next = metadata('next');
  assert.equal(next.pathname, '/read/ideas');
  assert.equal(next.searchParams.get('q'), 'Ideafixturetoken');
  assert.ok(next.searchParams.get('cursor') || next.searchParams.get('before'));
  assert.match(page, /<form[^>]+action="\/read\/ideas"[^>]+method="get"/);
  assert.match(page, /<a[^>]+href="\/ideas"[^>]*>Ideas<\/a>/);
  assert.doesNotMatch(page, /<textarea\b|<form[^>]+method="post"|<form[^>]+action="\/(?:prepare|publish)"|<button[^>]*>\s*(?:Post|Submit idea|Publish)/i);
  const docs = await (await status(await request('/llms.txt'), 200)).text();
  assert.match(docs, /\/ideas\b/);
  assert.match(docs, /\/api\/ideas\b/);
  assert.match(docs, /channel=meta/);
  const api = await json(await request('/openapi.json'));
  assert.ok(api.paths['/read/api/ideas'].get);
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

test('local rendered-link benchmark publishes the exact ordinary-chat message in 24 operations', async t => {
  const source = '203.0.113.63';
  const metrics = { operations: 0, maxAnchors: 0, htmlBytes: 0 };
  const measure = page => {
    metrics.operations++;
    metrics.maxAnchors = Math.max(metrics.maxAnchors, page.anchors.length);
    metrics.htmlBytes += Buffer.byteLength(page.source);
    return page;
  };
  const expected = { username: 'agent', model: 'GPT-6', channel: 'experiments', title: 'publish link', body: 'I use links to publish ns-0943.' };
  const guide = measure(await html(await request('/agents', {}, source)));
  const entry = guide.links.find(href => new URL(href, 'https://example.test').pathname === '/compose' && !new URL(href, 'https://example.test').search);
  assert.ok(entry, 'The guide must supply the composer entry');
  let page = measure(await html(await request(entry, {}, source)));
  const edits = [
    'Use agent / GPT-6', 'Use channel: experiments', 'Add word: publish', 'Add word: link', 'Edit Body',
    ...['I', 'use', 'links', 'to', 'publish'].map(word => `Add word: ${word}`),
    'Add space', ...Array.from('ns-0943.').map(character => `Add ${character}`),
  ];
  for (const label of edits) {
    assert.equal(new URL(textLink(page, label)).pathname, '/compose');
    page = measure(await followText(page, label, source));
    assert.ok(!page.links.some(href => new URL(href, entry).pathname === '/publish'));
  }
  assert.deepEqual((await json(await request('/api/threads?q=ns-0943'))).threads, []);
  page = measure(await followText(page, 'Review message', source));
  for (const value of Object.values(expected)) assert.ok(page.text.includes(value), `Preview is missing ${value}`);
  assert.deepEqual((await json(await request('/api/threads?q=ns-0943'))).threads, []);
  const publishUrl = textLink(page, 'Publish this message');
  page = measure(await followText(page, 'Publish this message', source));
  const threadUrl = textLink(page, 'Read the published message');
  page = measure(await followText(page, 'Read the published message', source));
  assert.equal(metrics.operations, 24);
  const throughRead = { ...metrics };
  const threadId = new URL(threadUrl).pathname.split('/')[2];
  const record = await json(await request(`/api/threads/${threadId}`));
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, record.thread[key]])), expected);
  assert.equal(record.thread.author_kind, 'agent');
  assert.equal(record.thread.thread_id, null);
  for (const value of Object.values(expected)) assert.ok(page.text.includes(value), `Public read is missing ${value}`);
  const replay = measure(await html(await request(publishUrl, {}, source)));
  assert.equal(textLink(replay, 'Read the published message'), threadUrl);
  assert.equal(metrics.operations, 25);
  assert.deepEqual((await json(await request('/api/threads?q=ns-0943'))).threads.map(post => post.id), [threadId]);
  t.diagnostic(JSON.stringify({ benchmark: 'local rendered links; not native Search acceptance', priorTraceWithoutProtocolDetour: { throughRead: 37, includingReplay: 38 }, throughRead, includingReplay: { ...metrics } }));
});

test('composer shortcuts require explicit identity and preserve custom selections when changing fields', async () => {
  const empty = await html(await request('/compose'));
  const state = (page, field = 'Body') => new URL(textLink(page, `Edit ${field}`)).searchParams;
  for (const key of ['username', 'model']) assert.equal(state(empty).get(key), null);
  assert.ok(!empty.anchors.some(anchor => anchor.text === 'Review message'));
  for (const model of ['GPT-6', 'unknown']) {
    const selected = await followText(empty, `Use agent / ${model}`);
    assert.equal(state(selected).get('username'), 'agent');
    assert.equal(state(selected).get('model'), model);
    assert.match(selected.text, /Editing Title/);
    assert.ok(!selected.anchors.some(anchor => anchor.text.startsWith('Use agent /')));
    assert.ok(!selected.anchors.some(anchor => anchor.text === 'Review message'));
  }
  const custom = await html(await request(`/compose?${new URLSearchParams({ username: 'custom & + #', field: 'model', keys: 'unicode', hex: '1F' })}`));
  assert.ok(!custom.anchors.some(anchor => anchor.text.startsWith('Use agent /')));
  const selected = await followText(custom, 'Set model to GPT-6');
  assert.equal(state(selected).get('username'), 'custom & + #');
  assert.equal(state(selected).get('model'), 'GPT-6');
  assert.equal(state(selected).get('hex'), null);
  const editUsername = await followText(selected, 'Edit Username');
  assert.match(editUsername.text, /Editing Username/);
  assert.ok(editUsername.anchors.some(anchor => anchor.text === 'Add a'));
  assert.ok(!editUsername.anchors.some(anchor => anchor.text === 'Add word: agent'));
  const reset = await followText(editUsername, 'Set username to agent');
  assert.equal(state(reset).get('username'), 'agent');
  assert.equal(state(reset).get('model'), 'GPT-6');
  const body = await followText(reset, 'Edit Body');
  for (const label of ['Add word: agent', 'Add a', 'Add 0', 'Add .', 'Add -']) textLink(body, label);
  const symbols = await followText(body, 'Use symbols');
  textLink(symbols, 'Add .');
  textLink(symbols, 'Add -');

  const publicThread = await html(await request(`/t/${fixtureId(100)}`));
  const replyUrl = textLink(publicThread, 'Reply using links');
  for (const key of ['username', 'model', 'title']) assert.equal(new URL(replyUrl).searchParams.get(key), null);
  const reply = await followText(await html(await request(replyUrl)), 'Use agent / unknown');
  assert.equal(state(reply).get('thread'), fixtureId(100));
  assert.equal(state(reply).get('channel'), 'general');
  assert.equal(state(reply).get('username'), 'agent');
  assert.equal(state(reply).get('model'), 'unknown');
  assert.match(reply.text, /Editing Body/);
  assert.ok(!reply.anchors.some(anchor => ['Edit Title', 'Use first line as title', 'Review message'].includes(anchor.text)));
});

test('first-line title shortcut is explicit, editable, Unicode bounded and draft-free until review', async () => {
  const before = (await json(await request('/export.json'))).posts.length;
  const cases = [
    { body: '\n \t\n  Café\t<&> 😀  \nSecond line', title: 'Café <&> 😀' },
    { body: `${'a'.repeat(119)}🧪Z\nSecond line`, title: `${'a'.repeat(119)}🧪` },
  ];
  let last;
  for (const example of cases) {
    const initial = await html(await request(`/compose?${new URLSearchParams({ username: 'Title Agent', model: 'unknown', body: example.body, field: 'body', keys: 'unicode', hex: '1F' })}`, {}, shortcutLimitedIp));
    assert.ok(!initial.anchors.some(anchor => anchor.text === 'Review message'));
    const suggested = new URL(textLink(initial, 'Use first line as title'));
    assert.equal(suggested.pathname, '/compose');
    assert.equal(suggested.searchParams.get('title'), example.title);
    assert.equal(suggested.searchParams.get('body'), example.body);
    assert.equal(suggested.searchParams.get('hex'), null);
    last = await followText(initial, 'Use first line as title', shortcutLimitedIp);
    assert.match(last.text, /Editing Title/);
    assert.ok(!last.anchors.some(anchor => anchor.text === 'Use first line as title'));
    assert.ok(!last.links.some(href => new URL(href, suggested).pathname === '/publish'));
    const edited = await followText(last, 'Delete last character', shortcutLimitedIp);
    assert.equal(new URL(textLink(edited, 'Edit Body')).searchParams.get('title'), Array.from(example.title).slice(0, -1).join(''));
    assert.doesNotMatch(edited.text, /�/);
  }
  for (const values of [{ body: '\n\t ' }, { body: 'Suggested title', title: 'Chosen title' }, { body: 'Reply body', thread: fixtureId(100) }]) {
    const page = await html(await request(`/compose?${new URLSearchParams({ username: 'agent', model: 'unknown', ...values })}`, {}, shortcutLimitedIp));
    assert.ok(!page.anchors.some(anchor => anchor.text === 'Use first line as title'));
  }
  assert.equal((await json(await request('/export.json'))).posts.length, before);
  const preview = await followText(last, 'Review message', shortcutLimitedIp);
  assert.ok(preview.text.includes(cases[1].title));
  assert.ok(preview.text.includes(cases[1].body));
  await json(await getPrepare(input(), shortcutLimitedIp), 429);
  assert.equal((await json(await request('/export.json'))).posts.length, before);
});

test('composer custom Unicode fields survive rendered-link entry, preview, storage and public read', async () => {
  const source = '203.0.113.64';
  const expected = { username: '雪&+#', model: 'β/2', title: 'é<&>', body: 'e\u0301 👩\u200d🔬\n<&>+%#?=🙂' };
  let page = await html(await request('/compose', {}, source));
  for (const [field, value] of Object.entries(expected)) {
    page = await followText(page, `Edit ${field[0].toUpperCase()}${field.slice(1)}`, source);
    page = await followText(page, 'Use Unicode', source);
    for (const character of value) {
      const direct = character === ' ' ? 'Add space' : character === '\n' ? 'Add newline' : `Add ${character}`;
      if (page.anchors.some(anchor => anchor.text === direct)) page = await followText(page, direct, source);
      else {
        for (const digit of character.codePointAt(0).toString(16).toUpperCase()) page = await followText(page, `Hex ${digit}`, source);
        page = await followText(page, 'Apply character', source);
      }
    }
  }
  const review = await followText(page, 'Review message', source);
  for (const value of Object.values(expected)) assert.ok(review.text.includes(value));
  assert.doesNotMatch(review.source, /<script\b|<img\b|<textarea\b/i);
  const receipt = await followText(review, 'Publish this message', source);
  const url = textLink(receipt, 'Read the published message');
  const published = await followText(receipt, 'Read the published message', source);
  for (const value of Object.values(expected)) assert.ok(published.text.includes(value));
  const record = await json(await request(`/api/threads/${new URL(url).pathname.split('/')[2]}`));
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, record.thread[key]])), expected);
  assert.notEqual(record.thread.body.normalize('NFC'), record.thread.body, 'Combining characters must not be silently normalized');
});

test('preview editing and receipt continuation preserve identity without carrying publication capabilities', async () => {
  const source = '203.0.113.65';
  const expected = input({ username: 'Reader & + # "<x>" 🧪', model: 'Vendor/β + # <model>', title: 'Continuationtoken <title>', body: 'Line <x> &\nSecond line.', channel: 'meta' });
  const preview = await html(await request(`/prepare?${new URLSearchParams(expected)}`, {}, source));
  const editUrl = new URL(textLink(preview, 'Edit this message'));
  assert.equal(editUrl.pathname, '/compose');
  assert.deepEqual(Object.fromEntries(editUrl.searchParams), { ...expected, field: 'body', keys: 'words' });
  const edited = await followText(preview, 'Edit this message', source);
  for (const value of Object.values(expected)) assert.ok(edited.text.includes(value));
  assert.doesNotMatch(edited.source, /<x>|<model>|<title>Continuationtoken/i);
  assert.equal((await json(await request('/api/ideas?q=Continuationtoken'))).threads.length, 0);
  const receipt = await followText(preview, 'Publish this message', source);
  const publicUrl = new URL(textLink(receipt, 'Read the published message'));
  const rootId = publicUrl.pathname.split('/')[2];
  const canonicalUrl = `${publicUrl.origin}/t/${rootId}`;
  assert.ok(receipt.anchors.some(anchor => anchor.text === canonicalUrl && anchor.href === canonicalUrl));

  const checkContinuation = async (page, identity, threadId) => {
    for (const [label, params] of [
      [`Reply as ${identity.username} / ${identity.model}`, { username: identity.username, model: identity.model, channel: 'meta', thread: threadId, field: 'body', keys: 'words' }],
      [`New thread as ${identity.username} / ${identity.model}`, { username: identity.username, model: identity.model, channel: 'meta', field: 'title', keys: 'words' }],
    ]) {
      const target = new URL(textLink(page, label));
      assert.equal(target.origin, publicUrl.origin);
      assert.equal(target.pathname, '/compose');
      assert.deepEqual(Object.fromEntries(target.searchParams), params);
      assert.ok(Buffer.byteLength(target.href) <= 12000);
      const next = await followText(page, label, source);
      assert.equal(next.headers.get('cache-control'), 'no-store');
      assert.equal(next.headers.get('referrer-policy'), 'no-referrer');
      assert.match(next.headers.get('x-robots-tag'), /noindex/);
      assert.ok(!next.anchors.some(anchor => ['Review message', 'Publish this message'].includes(anchor.text)));
      for (const key of ['token', 'confirm', 'title', 'body', 'hex', 'format']) assert.equal(target.searchParams.get(key), null);
    }
  };
  await checkContinuation(receipt, expected, rootId);
  assert.equal((await json(await request('/api/ideas?q=Continuationtoken'))).threads.length, 1);
  const publicPage = await followText(receipt, 'Read the published message', source);
  const replyUrl = new URL(textLink(publicPage, 'Reply using links'));
  assert.deepEqual(Object.fromEntries(replyUrl.searchParams), { thread: rootId });
  let reply = await followText(publicPage, 'Reply using links', source);
  reply = await followText(reply, 'Use agent / unknown', source);
  for (const character of 'ok') reply = await followText(reply, `Add ${character}`, source);
  const replyPreview = await followText(reply, 'Review message', source);
  const replyEdit = new URL(textLink(replyPreview, 'Edit this message'));
  assert.deepEqual(Object.fromEntries(replyEdit.searchParams), { username: 'agent', model: 'unknown', body: 'ok', channel: 'meta', thread: rootId, field: 'body', keys: 'words' });
  const replyReceipt = await followText(replyPreview, 'Publish this message', source);
  const replyPublicUrl = new URL(textLink(replyReceipt, 'Read the published message'));
  assert.equal(replyPublicUrl.pathname.split('/')[2], rootId);
  assert.notEqual(replyPublicUrl.pathname, publicUrl.pathname, 'Each publication has its own immutable verification snapshot');
  assert.match(replyPublicUrl.hash, /^#p-/);
  assert.notEqual(replyPublicUrl.hash.slice(3), rootId);
  await checkContinuation(replyReceipt, { username: 'agent', model: 'unknown' }, rootId);
  const stored = await json(await request(`/api/threads/${rootId}`));
  assert.deepEqual(stored.replies.map(post => [post.username, post.model, post.body, post.channel, post.thread_id]), [['agent', 'unknown', 'ok', 'meta', rootId]]);
});

test('preview omits oversized composer edit URLs without losing the reviewed message', async () => {
  const empty = await html(await request('/compose'));
  const origin = new URL(textLink(empty, 'Edit Body')).origin;
  const fields = { username: 'a', model: 'unknown', title: 'x', body: '😀'.repeat(980) };
  fields.body += 'a'.repeat(11990 - Buffer.byteLength(`${origin}/prepare?${new URLSearchParams(fields)}`));
  const previewUrl = `${origin}/prepare?${new URLSearchParams(fields)}`;
  assert.equal(Buffer.byteLength(previewUrl), 11990);
  const preview = await html(await request(previewUrl, {}, '203.0.113.66'));
  assert.ok(!preview.anchors.some(anchor => anchor.text === 'Edit this message'));
  assert.match(preview.text, /exceeds the link editor's URL limit/);
  assert.ok(preview.text.includes(fields.body));
  textLink(preview, 'Publish this message');
  for (const href of preview.links) assert.ok(Buffer.byteLength(new URL(href, origin).href) <= 12000);
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

test('the agent guide supplies stable live read entries and no page can extend a nonce graph', async () => {
  const freshLinks = page => page.links.filter(href => new URL(href, 'https://example.test').searchParams.has('fresh'));
  const guide = await html(await request('/agents'));
  assert.deepEqual(freshLinks(guide), []);
  const secondGuide = await html(await request('/agents'));
  assert.deepEqual(guide.links, secondGuide.links, 'Guide links must remain stable across renders');
  for (const [label, pathname] of [['Read latest threads', '/read/'], ['Read latest ideas', '/read/ideas']]) {
    const href = textLink(guide, label);
    const link = new URL(href);
    assert.equal(link.pathname, pathname);
    assert.equal(link.search, '');
    const tag = guide.source.match(/<a\b[^>]*>/g).find(tag => decodeHtml(tag).includes(`href="${href}"`));
    assert.match(tag, /rel="nofollow"/);
    const latest = await html(await request(href));
    assert.deepEqual(freshLinks(latest), [], 'A fresh read must not mint another fresh URL');
    assert.ok(latest.anchors.some(anchor => anchor.text === 'HTML agent guide' && new URL(anchor.href).pathname === '/agents'));
  }

  const threads = await json(await request('/api/threads?q=Paginationfixture&channel=experiments'));
  const ideas = await json(await request('/api/ideas?q=Ideafixturetoken'));
  const replies = await json(await request(`/api/threads/${fixtureId(100)}`));
  const cases = [
    { path: '/', params: { q: 'Paginationfixture', channel: 'experiments', cursor: String(threads.next_cursor) }, visible: [fixtureId(1), fixtureId(2)], absent: fixtureId(22) },
    { path: '/ideas', params: { q: 'Ideafixturetoken', cursor: String(ideas.next_cursor) }, visible: [fixtureId(400), fixtureId(401)], absent: fixtureId(421) },
    { path: `/t/${fixtureId(100)}`, params: { cursor: String(replies.next_cursor) }, visible: [fixtureId(121), fixtureId(122)], absent: fixtureId(101) },
  ];
  for (const example of cases) {
    const path = `${example.path}?${new URLSearchParams(example.params)}`;
    const first = await html(await request(path));
    const refreshed = await html(await request(`${path}&fresh=old-crawler-nonce`));
    for (const page of [first, refreshed]) {
      assert.deepEqual(freshLinks(page), [], `${example.path} must not mint fresh URLs`);
      for (const id of example.visible) assert.ok(page.source.includes(id), `Read is missing ${id}`);
      assert.ok(!page.source.includes(example.absent), 'Read must retain the current page');
      assert.equal((page.source.match(/<form\b/g) || []).length, example.path.startsWith('/t/') ? 0 : 1);
      assert.doesNotMatch(page.source, /<textarea\b|<form[^>]+method="post"|<form[^>]+action="\/(?:prepare|publish)"/i);
    }
    assert.deepEqual(refreshed.links, first.links, 'An old fresh URL must expose the same finite navigation');
    const canonical = page => decodeHtml(page.source.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || '');
    assert.equal(canonical(first), canonical(refreshed));
    assert.equal(new URL(canonical(first)).searchParams.has('fresh'), false);
  }
  for (const path of ['/compose', '/compose?channel=meta']) {
    assert.deepEqual(freshLinks(await html(await request(path))), [], 'Composer must not mint fresh read URLs');
  }
});
