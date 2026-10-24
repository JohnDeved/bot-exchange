import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { refreshPublicSnapshots, renderPublicSnapshots, snapshotThreadPath } from '../src/snapshots.ts';

const threadId = '00000000-0000-4000-8000-000000000001';
const replyId = '00000000-0000-4000-8000-000000000002';
const post = { id: replyId, thread_id: threadId, seq: 12, channel: 'general' };
const origin = 'https://bot-exchange.example';
const proof = '0123456789abcdef0123456789abcdef';

function database(revision = 12, ids = [threadId], firstRoot = 1) {
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT COALESCE(MAX(seq)')) return { first: async () => revision };
      if (sql.startsWith('SELECT seq FROM posts WHERE seq BETWEEN')) return { bind: () => ({ first: async () => firstRoot }) };
      assert.match(sql, /thread_id IS NULL AND hidden=0/);
      assert.match(sql, /LIMIT 25001$/);
      return { all: async () => ({ results: ids.map(id => typeof id === 'string' ? ({ id, seq: 1 }) : id) }) };
    },
  };
}

function renderer(calls, override) {
  return async request => {
    const url = new URL(request.url);
    calls.push(url.pathname + url.search);
    const special = await override?.(url);
    if (special) return special;
    let type = 'text/html; charset=utf-8';
    let body = '<html><body>Visible message</body></html>';
    if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.json')) { type = 'application/json'; body = JSON.stringify({ threads: [], next_cursor: null }); }
    else if (url.pathname.endsWith('.xml')) { type = 'application/xml'; body = '<?xml version="1.0"?><root />'; }
    else if (url.pathname.endsWith('.svg')) { type = 'image/svg+xml'; body = '<svg xmlns="http://www.w3.org/2000/svg" />'; }
    else if (url.pathname.endsWith('.css')) { type = 'text/css'; body = 'body { color: black }'; }
    else if (url.pathname.endsWith('.ttf')) { type = 'font/ttf'; body = new Uint8Array([0, 1, 2, 3]); }
    else if (url.pathname.endsWith('.txt')) { type = 'text/plain'; body = url.pathname === `/${proof}.txt` ? proof : 'Public instructions'; }
    return new Response(body, { headers: { 'Content-Type': type } });
  };
}

class Bucket {
  objects = new Map();
  putCalls = [];
  beforePut;
  async head(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, customMetadata: { ...object.customMetadata } } : null;
  }
  set(key, body, revision) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.slice(0);
    this.objects.set(key, { body: bytes, etag: createHash('md5').update(new Uint8Array(bytes)).digest('hex'), customMetadata: { revision: String(revision) } });
  }
  async put(key, body, options) {
    this.putCalls.push(key);
    await this.beforePut?.(key, body, options);
    const current = this.objects.get(key);
    if (options.onlyIf.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf.etagDoesNotMatch === '*' && current) return null;
    this.set(key, body, options.customMetadata.revision);
    Object.assign(this.objects.get(key), { httpMetadata: options.httpMetadata });
    return this.head(key);
  }
}

async function collect(db, options) {
  const snapshots = [];
  for await (const snapshot of renderPublicSnapshots(db, options)) snapshots.push(snapshot);
  return snapshots;
}
const decode = snapshot => new TextDecoder().decode(snapshot.body);

test('backfill renders only public allowlisted pages and exact immutable font/proof bytes', async () => {
  const calls = [];
  const snapshots = await collect(database(), { origin, appFetch: renderer(calls), indexNowKey: proof });
  const keys = snapshots.map(snapshot => snapshot.key);
  assert.ok(keys.includes('index.html'));
  assert.ok(keys.includes(`t/${threadId}`));
  assert.ok(keys.includes(`api/threads/${threadId}`));
  assert.ok(keys.includes('agents'));
  assert.ok(keys.includes('robots.txt'));
  for (const channel of ['general', 'introductions', 'experiments']) {
    assert.ok(keys.includes(`channels/${channel}`));
    assert.ok(keys.includes(`api/channels/${channel}`));
  }
  assert.ok(keys.includes('sitemap.xml'));
  assert.equal(calls.some(path => /compose|prepare|publish|health/.test(path)), false);
  assert.equal(calls.some(path => path.includes('?')), false);
  assert.deepEqual([...new Uint8Array(snapshots.find(snapshot => snapshot.key === 'fonts/pixel-operator-v1.ttf').body)], [0, 1, 2, 3]);
  assert.equal(decode(snapshots.find(snapshot => snapshot.key === `${proof}.txt`)), proof);
  assert.equal(JSON.parse(decode(snapshots.find(snapshot => snapshot.key === 'api/threads'))).snapshot_revision, 12);
  assert.match(decode(snapshots.find(snapshot => snapshot.key === 'robots.txt')), /\n# snapshot-revision:12/);
  assert.match(snapshots.find(snapshot => snapshot.key === 'index.html').httpMetadata.cacheControl, /max-age=0, s-maxage=60/);
});

test('publication refresh is bounded and creates an immediate read path for a reply beyond page one', async () => {
  const calls = [];
  const bucket = new Bucket();
  const result = await refreshPublicSnapshots({ DB: database(), PUBLIC_READS: bucket }, { origin, appFetch: renderer(calls), changedPost: post });
  assert.equal(calls.length, 8);
  assert.equal(calls.includes('/channels/general'), true);
  assert.equal(calls.includes('/channels/experiments'), false);
  assert.equal(calls.includes('/feed.xml'), false);
  assert.equal(calls.includes('/sitemap.xml'), false);
  assert.equal(calls.includes(`/t/${threadId}?after=11`), true);
  assert.equal(calls.includes('/style.css'), false);
  assert.equal(calls.includes('/agents'), false);
  assert.equal(result.threadUrl, `${origin}/t/${threadId}/v/12#p-${replyId}`);
  assert.equal(snapshotThreadPath({ id: threadId, thread_id: null, seq: 1 }), `/t/${threadId}/v/1`);
  assert.match(bucket.objects.get(`t/${threadId}/v/12`).httpMetadata.cacheControl, /immutable/);
  assert.equal(bucket.putCalls.at(-1), `t/${threadId}/v/12`, 'Verification object marks completion and must be stored last');
});

test('conditional writes cannot overwrite a newer concurrent revision, including unchanged visible content', async () => {
  const calls = [];
  const appFetch = renderer(calls);
  const older = (await collect(database(12), { origin, appFetch, changedPost: post }))[0];
  const newer = (await collect(database(13), { origin, appFetch, changedPost: post }))[0];
  assert.notEqual(decode(older), decode(newer), 'Revision markers must change the object ETag');
  const bucket = new Bucket();
  bucket.set('index.html', 'existing revision', 11);
  let raced = false;
  bucket.beforePut = async key => {
    if (key === 'index.html' && !raced) { raced = true; bucket.set(key, newer.body, 13); }
  };
  await refreshPublicSnapshots({ DB: database(12), PUBLIC_READS: bucket }, { origin, appFetch, changedPost: post });
  assert.equal(bucket.objects.get('index.html').customMetadata.revision, '13');
  assert.equal(decode(bucket.objects.get('index.html')), decode(newer));
});

test('failed refresh surfaces the error and an idempotent retry repairs missing snapshots', async () => {
  const bucket = new Bucket();
  await assert.rejects(refreshPublicSnapshots({ DB: database(), PUBLIC_READS: bucket }, {
    origin, changedPost: post, appFetch: renderer([], url => url.pathname === '/export.json' ? new Response('Unavailable', { status: 503 }) : undefined),
  }), /export.json returned 503/);
  assert.ok(bucket.objects.has('index.html'));
  assert.equal(bucket.objects.has('export.json'), false);
  await refreshPublicSnapshots({ DB: database(), PUBLIC_READS: bucket }, { origin, changedPost: post, replayed: true, appFetch: renderer([]) });
  assert.ok(bucket.objects.has('export.json'));
  assert.ok(bucket.objects.has(`t/${threadId}/v/12`));
  assert.equal(bucket.putCalls.filter(key => key === 'index.html').length, 1);
});

test('backfill limits and render validation fail before exposing invalid or redirected content', async () => {
  await assert.rejects(collect(database(12, Array(25001).fill(threadId)), { origin, appFetch: renderer([]) }), /exceeds 25000/);
  await assert.rejects(collect(database(), { origin, appFetch: renderer([]), indexNowKey: '../private' }), /proof key/);
  await assert.rejects(collect(database(), { origin, appFetch: renderer([], () => Response.redirect('https://elsewhere.example')) }), /returned 302/);
  await assert.rejects(collect(database(), { origin, appFetch: renderer([], () => new Response('wrong', { headers: { 'Content-Type': 'application/octet-stream' } })) }), /content type/);
});


test('sitemap updates render only a changed seq partition and repair its interrupted first refresh', async () => {
  const rootPost = { id: threadId, thread_id: null, seq: 12, channel: 'general' };
  const calls = [];
  const existing = new Bucket();
  existing.set('sitemaps/0.xml', '<urlset />', 11);
  await refreshPublicSnapshots({ DB: database(), PUBLIC_READS: existing }, { origin, appFetch: renderer(calls), changedPost: rootPost });
  assert.equal(calls.includes('/sitemaps/0.xml'), true);
  assert.equal(calls.includes('/sitemap.xml'), false, 'Existing partition does not require rescanning the index');
  const repairing = [];
  await refreshPublicSnapshots({ DB: database(), PUBLIC_READS: new Bucket() }, { origin, appFetch: renderer(repairing), changedPost: rootPost });
  assert.equal(repairing.includes('/sitemap.xml'), true, 'Missing partition repairs the index even when another root was first');
  const sparse = await collect(database(2000000001, [{ id: threadId, seq: 1 }, { id: replyId, seq: 2000000001 }]), { origin, appFetch: renderer([]) });
  assert.deepEqual(sparse.map(snapshot => snapshot.key).filter(key => /^sitemaps\/\d/.test(key)), ['sitemaps/0.xml', 'sitemaps/2000000.xml']);
});


test('completed publication replay performs one R2 HEAD without rendering or querying D1', async () => {
  const key = `t/${threadId}/v/12`;
  for (const metadata of [{ revision: '17' }, {}]) {
    const heads = [];
    const result = await refreshPublicSnapshots({
      DB: { prepare: () => assert.fail('Completed replay must not query D1 again') },
      PUBLIC_READS: {
        head: async requested => { heads.push(requested); return { customMetadata: metadata }; },
        put: () => assert.fail('Completed replay must not write R2'),
      },
    }, {
      origin, changedPost: post, replayed: true,
      appFetch: () => assert.fail('Completed replay must not render pages'),
    });
    assert.deepEqual(heads, [key]);
    assert.deepEqual(result.keys, []);
    assert.equal(result.revision, metadata.revision ? 17 : 12);
    assert.equal(result.threadUrl, `${origin}/${key}#p-${replyId}`);
  }
});
