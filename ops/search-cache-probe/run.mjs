import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [target, output] = process.argv.slice(2);
if (!target || !output) throw new Error('Usage: node ops/search-cache-probe/run.mjs HTTPS_ORIGIN OUTPUT_JSON');
const origin = new URL(target);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('Supply the isolated HTTPS origin only');
}
if (origin.hostname !== 'search-cache-probe.objekt.stream') throw new Error('Only the isolated probe hostname is allowed');
if (Date.now() < Date.parse('2026-10-25T00:00:00Z')) throw new Error('The shared Worker quota is exhausted. Do not run before 2026-10-25 00:00 UTC.');

const run = randomUUID();
const started = new Date().toISOString();
const observations = [];
const outputPath = resolve(output);
await mkdir(dirname(outputPath), { recursive: true });
const save = async (summary) => writeFile(outputPath, JSON.stringify({
  origin: origin.origin, run, started, ended: new Date().toISOString(), observations,
  ...summary,
}, null, 2) + '\n');

try {
  for (const [group, count] of [['a', 11], ['b', 11], ['control', 5]]) {
    const url = new URL(`/_bot-exchange/probe/${group === 'control' ? 'control' : 'cached'}`, origin);
    url.searchParams.set('q', `${run}-${group}`);
    for (let index = 0; index < count; index++) {
      // The existing zone limiter permits six requests per ten seconds.
      if (observations.length) await setTimeout(2200);
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const body = await response.text();
      let data;
      try { data = JSON.parse(body); } catch { data = null; }
      observations.push({
        group, index, at: new Date().toISOString(), url: url.href, status: response.status,
        cache: response.headers.get('cf-cache-status'), age: response.headers.get('age'),
        ray: response.headers.get('cf-ray'), cacheControl: response.headers.get('cache-control'),
        data, ...(data ? {} : { error: body.slice(0, 1500) }),
      });
      await save({ status: 'collecting', billingVerified: false });
      if (response.status !== 200 || !data?.execution_id || data.q !== url.searchParams.get('q')) {
        throw new Error(`Probe failed in ${group}/${index}: HTTP ${response.status}; stopping without retries`);
      }
      console.log(`${group} ${index + 1}/${count}: ${response.headers.get('cf-cache-status') || 'no cache status'}`);
    }
  }
  const a = observations.filter(row => row.group === 'a');
  const b = observations.filter(row => row.group === 'b');
  const controls = observations.filter(row => row.group === 'control');
  const unique = rows => new Set(rows.map(row => row.data.execution_id)).size;
  const sameBody = rows => new Set(rows.map(row => JSON.stringify(row.data))).size === 1;
  const responseChecksPass = [a, b].every(rows => unique(rows) === 1 && sameBody(rows)
    && ['MISS', 'EXPIRED'].includes(rows[0].cache) && rows.slice(1).every(row => row.cache === 'HIT'))
    && a[0].data.execution_id !== b[0].data.execution_id && unique(controls) === 5
    && controls.every(row => row.cache !== 'HIT' && row.cacheControl === 'no-store');
  await save({
    status: responseChecksPass ? 'responses-pass-accounting-unverified' : 'response-checks-failed',
    responseChecksPass, requests: observations.length, observedExecutionIds: unique(observations),
    cacheHits: observations.filter(row => row.cache === 'HIT').length,
    expectedFunctionRequests: 7, billingVerified: false,
    requiredNextCheck: 'Reconcile the exact test interval with Pages Function request metrics and execution logs. Cached bodies alone do not establish quota savings.',
  });
  if (!responseChecksPass) process.exitCode = 1;
  console.log(`Saved ${observations.length} observations. Function-request accounting remains unverified.`);
} catch (error) {
  await save({ status: 'stopped', billingVerified: false, error: String(error) });
  throw error;
}
