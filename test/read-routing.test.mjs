import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'bot-exchange-read-test-'));
const persistTo = join(temporary, 'state');
const id = '00000000-0000-4000-8000-000000000001';
let worker;
let searchDisabledWorker;

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = join(temporary, 'wrangler.log');
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }));

before(async () => {
  const d1 = (...args) => {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', ...args, '--local', '--persist-to', persistTo, '--config', join(root, 'wrangler.jsonc')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 60000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  d1('migrations', 'apply', 'agent-forum-db');
  const fixture = join(temporary, 'fixture.sql');
  writeFileSync(fixture, `INSERT INTO posts(id,title,body,author,model,author_kind,channel,created_at,updated_at,token_hash,client_key) VALUES('${id}','Live read fixture','Current archive content','reader','unknown','agent','meta',1,1,'read-routing-token','fixture');`);
  d1('execute', 'agent-forum-db', '--file', fixture);
  const { unstable_dev } = await import('wrangler');
  worker = await unstable_dev(join(root, 'src/index.ts'), {
    config: join(root, 'wrangler.jsonc'), local: true, ip: '127.0.0.1', port: 0,
    inspectorPort: 0, persistTo, vars: { INDEXNOW_KEY: '0'.repeat(32), SEARCH_ENABLED: 'true' }, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, forceLocal: true },
  });
  searchDisabledWorker = await unstable_dev(join(root, 'src/index.ts'), {
    config: join(root, 'wrangler.jsonc'), local: true, ip: '127.0.0.1', port: 0,
    inspectorPort: 0, persistTo, vars: { INDEXNOW_KEY: '0'.repeat(32), SEARCH_ENABLED: 'false' }, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, forceLocal: true },
  });
}, { timeout: 120000 });

after(async () => Promise.all([worker?.stop(), searchDisabledWorker?.stop()]));

test('public discovery keeps HTTPS through a local HTTP snapshot renderer', async t => {
  const { createTestHarness, unstable_readConfig: readConfig } = await import('wrangler');
  const config = readConfig({ config: join(root, 'wrangler.jsonc') });
  const renderer = createTestHarness({ root, workers: [{ config: {
    name: 'discovery-origin-test', main: join(root, 'src/index.ts'),
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    rules: config.rules, vars: config.vars,
  } }] });
  t.after(() => renderer.close());
  await renderer.listen();
  const direct = renderer.getWorker();
  const host = 'bot-exchange.objekt.stream';
  for (const path of ['/llms.txt', '/openapi.json', '/.well-known/agent.json', '/robots.txt']) {
    const response = await direct.fetch(`http://${host}${path}`);
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.ok(text.includes(`https://${host}`), `${path} must name the public HTTPS origin`);
    assert.ok(!text.includes(`http://${host}`), `${path} must not publish the renderer's HTTP origin`);
  }
  const legacy = await direct.fetch('http://bot-exchange.b-j.dev/prepare');
  assert.equal(legacy.status, 400, 'An empty preparation only validates fields');
  const legacyText = await legacy.text();
  assert.ok(legacyText.includes('https://bot-exchange.b-j.dev/agents'));
  assert.ok(!legacyText.includes('http://bot-exchange.b-j.dev'));

  for (const localOrigin of ['http://localhost:8787', 'http://exchange.test:9000']) {
    const response = await direct.fetch(`${localOrigin}/.well-known/agent.json`, { headers: {
      Forwarded: 'host=bot-exchange.objekt.stream;proto=https',
      'X-Forwarded-Host': 'bot-exchange.objekt.stream',
      'X-Forwarded-Proto': 'https',
    } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).guide, `${localOrigin}/agents`, 'Other origins retain their scheme and port; proxy headers are not trusted');
  }
});

test('search can be paused while browsing and composition remain available', async () => {
  for (const path of ['/search', '/api/search', '/api/search?q=fixture', '/read/api/search?q=fixture', '/?q=fixture', '/ideas?q=', '/read/channels/general?q=fixture', '/read/api/channels/general?q=fixture', '/_bot-exchange/read/api/ideas?q=fixture']) {
    const response = await searchDisabledWorker.fetch(path);
    assert.equal(response.status, 503, path);
    assert.match(await response.text(), /Search is temporarily unavailable/);
  }
  for (const path of ['/', '/ideas', '/channels/general', '/read/', '/read/api/threads', '/compose']) {
    const response = await searchDisabledWorker.fetch(path);
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.doesNotMatch(text, /role="search"/);
  }
  const schema = await (await searchDisabledWorker.fetch('/openapi.json')).json();
  assert.equal(schema.paths['/read/api/search'], undefined);
  for (const item of Object.values(schema.paths)) {
    assert.ok(!item.get?.parameters?.some(parameter => parameter.name === 'q'));
  }
  const guide = await (await searchDisabledWorker.fetch('/llms.txt')).text();
  assert.match(guide, /Search is temporarily unavailable/);
});

test('edge namespace preserves native links, search parameters and action methods', async () => {
  const compose = await worker.fetch('/_bot-exchange/compose?body=hello&username=agent&model=unknown');
  assert.equal(compose.status, 200);
  const html = await compose.text();
  assert.ok(!html.includes('/_bot-exchange/'), 'Internal routing must not escape into composer links');
  assert.match(html, /hello/);
  const search = await worker.fetch('/_bot-exchange/read/api/search?q=fixture');
  assert.equal(search.status, 200);
  assert.equal((await search.json()).posts[0].id, id);
  const preview = await worker.fetch('/_bot-exchange/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(preview.status, 400, 'The POST must reach field validation, not become a GET or 404');
  const invalid = await worker.fetch('/_bot-exchange/read/publish?token=invalid&confirm=publish');
  assert.equal(invalid.status, 404, 'Read prefix must remain unable to invoke publication');
});

test('explicit live reads reuse public handlers while keeping public canonical URLs', async () => {
  for (const path of ['/', '/ideas', '/channels/general', '/channels/introductions', '/channels/experiments', `/t/${id}`, '/export.json', '/sitemap.xml', '/feed.xml', '/api/threads', '/api/ideas', '/api/channels/general', '/api/channels/introductions', '/api/channels/experiments', `/api/threads/${id}`, '/api/search?q=fixture']) {
    const direct = await worker.fetch(path);
    const live = await worker.fetch(`/read${path}`);
    assert.equal(direct.status, 200, path);
    assert.equal(live.status, 200, path);
    assert.equal(live.headers.get('location'), null, 'Live reads must not redirect to a cached snapshot');
    assert.equal(live.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(live.headers.get('content-type'), direct.headers.get('content-type'));
    const text = await live.text();
    if (live.headers.get('content-type').includes('text/html')) {
      const canonical = new URL(text.match(/<link rel="canonical" href="([^"]+)"/)[1]);
      assert.equal(canonical.pathname, path);
      assert.ok(!canonical.pathname.startsWith('/read/'));
    }
    if (path === '/export.json') assert.equal(JSON.parse(text).posts[0].id, id);
    if (path === '/sitemap.xml') assert.ok(text.includes('/sitemaps/0.xml</loc>'));
    const head = await worker.fetch(`/read${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const search = await worker.fetch('/read/ideas?q=fixture');
  assert.match(await search.text(), /Live read fixture/);
  const sitemap = await worker.fetch('/sitemaps/0.xml');
  assert.equal(sitemap.status, 200);
  assert.ok((await sitemap.text()).includes(`/t/${id}</loc>`));
});

test('read dispatch excludes publishing, composing and nonpublic routes', async () => {
  for (const path of ['/prepare?body=test', '/publish?token=test&confirm=publish', '/compose', '/health', '/agents', '/read/', '/api/unknown', '/t/not-an-id', '/channels/meta', '/channels/invalid', '/api/channels/invalid']) {
    const response = await worker.fetch(`/read${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await worker.fetch('/read/api/threads', { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  const data = await (await worker.fetch('/read/export.json')).json();
  assert.equal(data.posts.length, 1, 'Rejected read-prefix actions must not create a post');
});

test('channel navigation stays static until search or pagination is requested', async () => {
  const archive = await (await worker.fetch('/')).text();
  for (const channel of ['general', 'introductions', 'experiments']) {
    assert.ok(archive.includes(`href="/channels/${channel}"`));
    const filtered = await (await worker.fetch(`/channels/${channel}?channel=meta`)).text();
    assert.ok(!filtered.includes('Live read fixture'), 'A query cannot override a fixed channel');
    assert.match(filtered, new RegExp(`action="/read/channels/${channel}"`));
    const canonical = new URL(filtered.match(/<link rel="canonical" href="([^"]+)"/)[1]);
    assert.equal(canonical.pathname, `/channels/${channel}`);
    const json = await (await worker.fetch(`/api/channels/${channel}?channel=meta`)).json();
    assert.deepEqual(json.threads, []);
  }
  assert.ok(archive.includes('href="/ideas"'));
  const searched = await (await worker.fetch('/read/?q=fixture')).text();
  assert.ok(searched.includes('href="/read/channels/general?q=fixture"'));
  const robots = await (await worker.fetch('/robots.txt')).text();
  assert.match(robots, /User-agent: \*[\s\S]*Disallow: \/read\n/);
});
