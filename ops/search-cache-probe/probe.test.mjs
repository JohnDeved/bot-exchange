import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import worker from './public/_worker.js';

const prefix = '/_bot-exchange/probe/';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const request = (path, init) => new Request(`https://cache-probe.example${path}`, init);
const noAssets = { ASSETS: { fetch: () => assert.fail('Probe paths must not reach static assets') } };

for (const [mode, policy] of [['cached', 'public, max-age=0, s-maxage=120'], ['control', 'no-store']]) {
  test(`${mode} executions create distinct invocation IDs for an identical query`, async t => {
    const logs = [];
    t.mock.method(console, 'log', text => logs.push(JSON.parse(text)));
    const responses = await Promise.all([0, 1].map(() => worker.fetch(request(`${prefix}${mode}?q=repeat_123`), noAssets)));
    const bodies = [];
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), policy);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
      const body = await response.json();
      assert.match(body.execution_id, uuid);
      assert.equal(response.headers.get('x-probe-invocation-id'), body.execution_id);
      assert.equal(response.headers.get('date'), new Date(body.generated_at).toUTCString());
      assert.equal(body.q, 'repeat_123');
      assert.equal(body.path, `${prefix}${mode}`);
      assert.equal(body.mode, mode);
      bodies.push(body);
    }
    assert.notEqual(bodies[0].execution_id, bodies[1].execution_id);
    assert.deepEqual(logs, bodies.map(body => ({ event: 'search-cache-probe', method: 'GET', ...body })));
  });

  test(`${mode} HEAD has matching policy and an empty body`, async t => {
    t.mock.method(console, 'log', () => {});
    const response = await worker.fetch(request(`${prefix}${mode}?q=head`, { method: 'HEAD' }), noAssets);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), policy);
    assert.match(response.headers.get('x-probe-invocation-id'), uuid);
    assert.equal(await response.text(), '');
  });
}

test('invalid methods never run a probe or fetch assets and cannot be cached', async t => {
  const log = t.mock.method(console, 'log', () => {});
  for (const path of [`${prefix}cached`, `${prefix}control`, '/missing']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await worker.fetch(request(path, { method }), noAssets);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(log.mock.callCount(), 0);
});

test('only a bounded marker query is accepted; rejected input is not logged or cached', async t => {
  const log = t.mock.method(console, 'log', () => {});
  for (const mode of ['cached', 'control']) {
    for (const query of ['', 'q=', 'q=a&q=b', 'other=secret', 'q=hello+world', 'q=%0A', 'q=%C3%A9', `q=${'a'.repeat(65)}`]) {
      const response = await worker.fetch(request(`${prefix}${mode}?${query}`), noAssets);
      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-probe-invocation-id'), null);
    }
  }
  assert.equal(log.mock.callCount(), 0);
  const accepted = await worker.fetch(request(`${prefix}cached?q=${'a'.repeat(64)}`), noAssets);
  assert.equal(accepted.status, 200);
  assert.equal(log.mock.callCount(), 1);
});

test('other read paths preserve the request and use the static asset fallback', async t => {
  const log = t.mock.method(console, 'log', () => {});
  for (const path of ['/', '/404.html', `${prefix}cached/`, `${prefix}control/extra`]) {
    const input = request(path);
    const assetResponse = new Response('Static not found', { status: 404 });
    const response = await worker.fetch(input, { ASSETS: { fetch: value => {
      assert.equal(value, input);
      return assetResponse;
    } } });
    assert.equal(response, assetResponse);
  }
  assert.equal(log.mock.callCount(), 0);
});

test('Pages configuration routes only the two probes and contains no production bindings', async () => {
  const routes = JSON.parse(await readFile(new URL('./public/_routes.json', import.meta.url), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: [`${prefix}cached`, `${prefix}control`], exclude: [] });
  const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'account_id', 'compatibility_date', 'name', 'pages_build_output_dir'].sort());
  assert.equal(config.name, 'bot-exchange-search-cache-probe');
  assert.equal(config.pages_build_output_dir, './public');
  assert.equal(config.compatibility_date, '2026-10-24');
  const page = await readFile(new URL('./public/404.html', import.meta.url), 'utf8');
  assert.match(page, /name="robots" content="noindex, nofollow, noarchive"/);
});
