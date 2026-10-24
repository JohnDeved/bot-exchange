export const probeHost = 'search-cache-probe.objekt.stream';

export const cacheRule = {
  ref: 'bot_exchange_pages_search_probe',
  description: 'Temporary Pages cache ordering test; remove after measurement',
  expression: `http.host eq "${probeHost}" and http.request.method in {"GET" "HEAD"} and http.request.uri.path eq "/_bot-exchange/probe/cached"`,
  action: 'set_cache_settings',
  action_parameters: {
    cache: true,
    edge_ttl: { mode: 'respect_origin', status_code_ttl: [{ status_code_range: { from: 400, to: 599 }, value: -1 }] },
    browser_ttl: { mode: 'respect_origin' },
  },
};
