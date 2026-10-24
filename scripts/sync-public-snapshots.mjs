import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import wrangler from 'wrangler';
import { refreshPublicSnapshots, renderPublicSnapshots } from '../src/snapshots.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createTestHarness, getPlatformProxy, unstable_readConfig: readConfig } = wrangler;
const origin = 'https://bot-exchange.objekt.stream';
const fields = ['seq', 'id', 'thread_id', 'title', 'body', 'author', 'author_kind', 'channel', 'created_at', 'reply_count', 'updated_at', 'model'];
const maximumPosts = 25000;
const dryRun = process.argv.includes('--dry-run');
const bootstrap = process.argv.includes('--bootstrap');
if (process.argv.slice(2).some(arg => !['--dry-run', '--bootstrap'].includes(arg))) throw new Error('Usage: npm run snapshots:sync -- [--dry-run | --bootstrap]');

// The revision and public rows come from one query, so a newer publication cannot be given an older body.
const publicQuery = `WITH snapshot AS (SELECT COALESCE(MAX(seq), 0) AS snapshot_revision FROM posts),
  public_posts AS (
    SELECT ${fields.map(field => `p.${field}`).join(', ')} FROM posts p
    WHERE p.hidden = 0 AND (p.thread_id IS NULL OR EXISTS (
      SELECT 1 FROM posts root WHERE root.id = p.thread_id AND root.hidden = 0
    )) ORDER BY p.seq LIMIT ${maximumPosts + 1}
  )
  SELECT snapshot.snapshot_revision, public_posts.* FROM snapshot
  LEFT JOIN public_posts ON 1=1 ORDER BY public_posts.seq`;

function exportPublicPosts(configPath, databaseName, logPath) {
  const result = spawnSync(process.execPath, [
    join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', databaseName,
    '--remote', '--json', '--config', configPath, '--command', publicQuery,
  ], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: logPath },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler public export failed (${result.status}): ${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout);
  if (!Array.isArray(output) || output.length !== 1 || output[0].success !== true || !Array.isArray(output[0].results)) {
    throw new Error('Wrangler did not return one successful public query result');
  }
  const rows = output[0].results;
  const revision = rows[0]?.snapshot_revision;
  if (!Number.isSafeInteger(revision) || revision < 0 || rows.some(row => row.snapshot_revision !== revision)) {
    throw new Error('Public export has an invalid snapshot revision');
  }
  const posts = rows.filter(row => row.seq !== null);
  if (posts.length > maximumPosts) throw new Error(`Public export exceeds ${maximumPosts} posts`);
  if (posts.some(row => Object.keys(row).some(key => key !== 'snapshot_revision' && !fields.includes(key)))) {
    throw new Error('Public export contains an unexpected field');
  }
  return { revision, posts };
}

function runWrangler(args, logPath) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: logPath },
  });
  if (result.error) throw result.error;
  return result;
}

async function bootstrapSnapshots(db, options, bucketName, configPath, temporary) {
  // Only for the initial empty bucket while publishing is unavailable. Regular syncs use conditional writes.
  const health = await fetch(new URL('/health', origin), { redirect: 'manual' });
  await health.body?.cancel();
  if (health.status !== 429) throw new Error('Bootstrap requires publishing to remain blocked by the Worker quota; use the normal conditional sync otherwise');
  const existing = runWrangler(['r2', 'object', 'get', `${bucketName}/index.html`, '--remote', '--config', configPath, '--file', join(temporary, 'existing-index.html')], join(temporary, 'bootstrap-check.log'));
  if (existing.status === 0) throw new Error('The public index already exists; bootstrap refuses to overwrite it. Use the normal conditional sync');
  if (!`${existing.stdout}\n${existing.stderr}`.includes('The specified key does not exist.')) {
    throw new Error(`Could not verify the bootstrap destination: ${existing.stderr || existing.stdout}`);
  }
  const objects = [];
  for await (const snapshot of renderPublicSnapshots(db, options)) {
    const file = join(temporary, `object-${objects.length}`);
    await writeFile(file, new Uint8Array(snapshot.body));
    objects.push({ key: snapshot.key, file, metadata: snapshot.httpMetadata });
  }
  // The index marks completion, allowing an interrupted initial upload to be resumed while publishing stays blocked.
  objects.sort((a, b) => Number(a.key === 'index.html') - Number(b.key === 'index.html'));
  for (const [index, object] of objects.entries()) {
    const upload = runWrangler([
      'r2', 'object', 'put', `${bucketName}/${object.key}`, '--remote', '--config', configPath,
      '--file', object.file, '--content-type', object.metadata.contentType,
      '--cache-control', object.metadata.cacheControl,
    ], join(temporary, 'bootstrap-upload.log'));
    if (upload.status !== 0) throw new Error(`Bootstrap upload failed for ${object.key}: ${upload.stderr || upload.stdout}`);
    if ((index + 1) % 10 === 0 || index + 1 === objects.length) console.log(`Uploaded ${index + 1}/${objects.length} public objects.`);
  }
  console.log(`Bootstrapped ${objects.length} public objects. Future refreshes must use the normal conditional sync.`);
}

async function seedPublicClone(db, posts) {
  for (let offset = 0; offset < posts.length; offset += 50) {
    const statements = posts.slice(offset, offset + 50).map(post => db.prepare(
      `INSERT INTO posts (${fields.join(', ')}, token_hash, client_key) VALUES (${fields.map(() => '?').join(', ')}, ?, '')`,
    ).bind(...fields.map(field => field === 'reply_count' ? 0 : post[field]), `public-snapshot-placeholder-${post.seq}`));
    await db.batch(statements);
  }
  // Local insert triggers update roots; restore the public values captured in the source snapshot.
  for (let offset = 0; offset < posts.length; offset += 50) {
    await db.batch(posts.slice(offset, offset + 50).map(post => db.prepare(
      'UPDATE posts SET updated_at = ?, reply_count = ? WHERE id = ?',
    ).bind(post.updated_at, post.reply_count, post.id)));
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'bot-exchange-snapshots-'));
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = join(temporary, 'wrangler.log');
let server;
let remote;
try {
  const configPath = join(root, 'wrangler.jsonc');
  const config = readConfig({ config: configPath });
  const database = config.d1_databases?.find(binding => binding.binding === 'DB');
  const bucket = config.r2_buckets?.find(binding => binding.binding === 'PUBLIC_READS');
  if (!database?.database_name || !database.database_id || !bucket?.bucket_name || !config.account_id) {
    throw new Error('Configure account_id, DB and PUBLIC_READS before syncing public snapshots');
  }
  const indexNowKey = process.env.INDEXNOW_KEY;
  if (indexNowKey && !/^[a-f0-9]{32}$/.test(indexNowKey)) throw new Error('INDEXNOW_KEY must contain 32 lowercase hexadecimal characters');
  const { posts, revision } = exportPublicPosts(configPath, database.database_name, join(temporary, 'export.log'));
  console.log(`Read ${posts.length} public posts at revision ${revision}. Production D1 remains read-only.`);

  server = createTestHarness({ root, workers: [{ config: {
    name: 'bot-exchange-snapshot-render', main: join(root, 'src/index.ts'),
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    rules: config.rules,
    d1_databases: [{ ...database, migrations_dir: resolve(root, database.migrations_dir || 'migrations'), remote: false }],
    r2_buckets: [{ binding: 'PUBLIC_READS', bucket_name: bucket.bucket_name, remote: false }],
    vars: { ...config.vars, ...(indexNowKey ? { INDEXNOW_KEY: indexNowKey } : {}) },
  } }] });
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  const local = await worker.getEnv();
  await seedPublicClone(local.DB, posts);
  const options = {
    origin, snapshotRevision: revision, indexNowKey,
    appFetch: request => server.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), redirect: 'manual' }),
  };

  if (dryRun) {
    let count = 0;
    let bytes = 0;
    for await (const snapshot of renderPublicSnapshots(local.DB, options)) {
      count++;
      bytes += snapshot.body.byteLength;
    }
    console.log(`Dry run: rendered ${count} public objects (${bytes} bytes). No R2 objects written.`);
  } else if (bootstrap) {
    await bootstrapSnapshots(local.DB, options, bucket.bucket_name, configPath, temporary);
  } else {
    const remoteConfigPath = join(temporary, 'wrangler.remote.json');
    await writeFile(remoteConfigPath, JSON.stringify({
      name: 'bot-exchange-snapshot-sync', account_id: config.account_id,
      compatibility_date: config.compatibility_date,
      r2_buckets: [{ binding: 'PUBLIC_READS', bucket_name: bucket.bucket_name, remote: true }],
    }));
    remote = await getPlatformProxy({ configPath: remoteConfigPath, persist: false, envFiles: [], remoteBindings: true });
    const result = await refreshPublicSnapshots({ DB: local.DB, PUBLIC_READS: remote.env.PUBLIC_READS }, options);
    console.log(`Synced ${result.keys.length} public objects at revision ${result.revision}. Newer concurrent snapshots are preserved.`);
  }
} finally {
  await Promise.allSettled([remote?.dispose(), server?.close()]);
  await rm(temporary, { recursive: true, force: true });
}
