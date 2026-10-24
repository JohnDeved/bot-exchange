import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedSearchRows, invalidateSearchRows, normalizeSearchQuery } from '../src/search-cache.ts';

const origin = 'https://bot-exchange.example';
const options = { origin, kind: 'threads', query: 'Tools agent' };
const row = { id: 'public-id', body: 'Public message' };

function edgeCache() {
  const responses = new Map();
  return {
    responses,
    async match(request) { return responses.get(request.url)?.clone(); },
    async put(request, response) { responses.set(request.url, response.clone()); },
  };
}

test('search normalization bounds tokens and collapses equivalent safe AND queries', () => {
  assert.equal(normalizeSearchQuery('  Tools, AGENT tools '), 'agent tools');
  assert.equal(normalizeSearchQuery('a OR b* NOT c NEAR(d) title:e'), 'a b c d near not or title');
  assert.equal(normalizeSearchQuery('one two three four five six seven eight nine'), 'eight five four one seven six three two');
  assert.equal(normalizeSearchQuery('汉字 résumé'), 'résumé 汉字');
  assert.equal(normalizeSearchQuery('*** !'), '');
  assert.throws(() => normalizeSearchQuery('x'.repeat(161)), error => error.status === 400);
});

test('equivalent concurrent searches share one load and expire after 30 seconds', async () => {
  const db = {};
  let clock = 1000;
  let loads = 0;
  let finish;
  const load = async query => { loads++; assert.equal(query, 'agent tools'); await new Promise(resolve => { finish = resolve; }); return [row]; };
  const first = cachedSearchRows(db, { ...options, now: () => clock }, load);
  const second = cachedSearchRows(db, { ...options, query: 'agent TOOLS tools', now: () => clock }, load);
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(loads, 1);
  results[0][0].body = 'Caller mutation';
  assert.equal(results[1][0].body, 'Public message');
  assert.deepEqual(await cachedSearchRows(db, { ...options, now: () => clock }, async () => assert.fail('Expected cache hit')), [row]);
  clock += 30000;
  await cachedSearchRows(db, { ...options, now: () => clock }, async () => { loads++; return [row]; });
  assert.equal(loads, 2);
});

test('edge cache reuses a public result across isolates and partitions mode/channel/cursor', async () => {
  const cache = edgeCache();
  let loads = 0;
  const load = async () => { loads++; return [row]; };
  await cachedSearchRows({}, { ...options, cache }, load);
  await cachedSearchRows({}, { ...options, query: 'agent Tools', cache }, load);
  assert.equal(loads, 1);
  for (const variant of [{ kind: 'posts' }, { channel: 'meta' }, { before: 20 }, { origin: 'https://different.example' }]) {
    await cachedSearchRows({}, { ...options, ...variant, cache }, load);
  }
  assert.equal(loads, 5);
  for (const [url, response] of cache.responses) {
    assert.match(new URL(url).pathname, /^\/\.search-cache\/v1\/[a-f0-9]{64}$/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
    assert.deepEqual((await response.clone().json()).rows, [row]);
  }
});

test('punctuation-only, invalid cursors, and oversized input never query the database', async () => {
  const load = async () => assert.fail('Invalid or empty search must not load');
  assert.deepEqual(await cachedSearchRows({}, { ...options, query: '!!' }, load), []);
  await assert.rejects(cachedSearchRows({}, { ...options, before: -1 }, load), error => error.status === 400);
  await assert.rejects(cachedSearchRows({}, { ...options, query: 'x'.repeat(161) }, load), error => error.status === 400);
});

test('cache failures fall back to search, while loader failures are not cached', async () => {
  const db = {};
  const cache = { match: async () => { throw new Error('Cache unavailable'); }, put: async () => { throw new Error('Cache unavailable'); } };
  await assert.rejects(cachedSearchRows(db, { ...options, cache }, async () => { throw new Error('Database unavailable'); }), /Database unavailable/);
  assert.deepEqual(await cachedSearchRows(db, { ...options, cache }, async () => [row]), [row]);
  await assert.rejects(cachedSearchRows({}, options, async () => Array(22).fill(row)), /bounded result/);
});

test('LRU and inflight registries are bounded during distinct-query floods', async () => {
  const db = {};
  const releases = [];
  const tasks = [];
  let loads = 0;
  const load = async () => { loads++; await new Promise(resolve => releases.push(resolve)); return [row]; };
  for (let i = 0; i < 129; i++) tasks.push(cachedSearchRows(db, { ...options, query: `query${i}` }, load));
  tasks.push(cachedSearchRows(db, { ...options, query: 'query0' }, load));
  tasks.push(cachedSearchRows(db, { ...options, query: 'query128' }, load));
  assert.equal(loads, 130, 'Only 128 inflight keys are retained; tracked keys still coalesce');
  releases.forEach(resolve => resolve());
  await Promise.all(tasks);
  let evictedLoads = 0;
  await cachedSearchRows(db, { ...options, query: 'query0' }, async () => { evictedLoads++; return [row]; });
  assert.equal(evictedLoads, 1, 'The oldest completed entry was evicted');
});

test('publication invalidates local results without restoring stale edge results', async () => {
  const db = {};
  const cache = edgeCache();
  await cachedSearchRows(db, { ...options, cache }, async () => []);
  invalidateSearchRows(db, 42);
  assert.deepEqual(await cachedSearchRows(db, { ...options, cache }, async () => [row]), [row]);
  assert.equal(cache.responses.size, 2, 'Publication starts a new cache generation without enumerating old keys');
  invalidateSearchRows(db, 41);
  assert.deepEqual(await cachedSearchRows(db, { ...options, cache }, async () => assert.fail('Older publication cannot roll back the generation')), [row]);
  assert.deepEqual(await cachedSearchRows({}, { ...options, cache }, async () => assert.fail('Other isolates may use the previous generation for 30 seconds')), []);
});

test('pre-publication inflight results cannot populate the new search generation', async () => {
  const db = {};
  let finish;
  const beforePublication = cachedSearchRows(db, options, async () => {
    await new Promise(resolve => { finish = resolve; });
    return [];
  });
  invalidateSearchRows(db, 10);
  assert.deepEqual(await cachedSearchRows(db, options, async () => [row]), [row]);
  finish();
  assert.deepEqual(await beforePublication, []);
  assert.deepEqual(await cachedSearchRows(db, options, async () => assert.fail('Old inflight completion must not replace current results')), [row]);
});
