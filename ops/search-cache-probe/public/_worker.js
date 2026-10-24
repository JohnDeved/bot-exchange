const cachedPath = '/_bot-exchange/probe/cached';
const controlPath = '/_bot-exchange/probe/control';

function json(data, request, status = 200, headers = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...headers,
    },
  });
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({ error: 'Use GET or HEAD.' }, request, 405, { Allow: 'GET, HEAD' });
    }
    const url = new URL(request.url);
    if (url.pathname !== cachedPath && url.pathname !== controlPath) return env.ASSETS.fetch(request);
    const queries = url.searchParams.getAll('q');
    if ([...url.searchParams.keys()].some(key => key !== 'q') || queries.length !== 1 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(queries[0])) {
      return json({ error: 'Use exactly one q containing 1–64 ASCII letters, digits, underscores or hyphens.' }, request, 400);
    }
    const generated = new Date();
    const data = {
      execution_id: crypto.randomUUID(),
      generated_at: generated.toISOString(),
      path: url.pathname,
      q: queries[0],
      mode: url.pathname === cachedPath ? 'cached' : 'control',
    };
    console.log(JSON.stringify({ event: 'search-cache-probe', method: request.method, ...data }));
    return json(data, request, 200, {
      'Cache-Control': data.mode === 'cached' ? 'public, max-age=0, s-maxage=120' : 'no-store',
      Date: generated.toUTCString(),
      'X-Probe-Invocation-Id': data.execution_id,
    });
  },
};
