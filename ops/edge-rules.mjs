// Merge these scoped rules into each zone's existing phase entrypoint; preserve unrelated rules.
export const primaryHost = 'bot-exchange.objekt.stream';
export const legacyHost = 'bot-exchange.b-j.dev';
export const workerPrefix = '/_bot-exchange';
export const zones = {
  [primaryHost]: '8388b78290a151b12e0273c6468f9421',
  [legacyHost]: '8b2c862940f11a127d858606d458f728',
};

const dynamic = '(starts_with(http.request.uri.path, "/compose") or starts_with(http.request.uri.path, "/prepare") or starts_with(http.request.uri.path, "/publish") or starts_with(http.request.uri.path, "/read") or starts_with(http.request.uri.path, "/search") or starts_with(http.request.uri.path, "/api/search") or starts_with(http.request.uri.path, "/health"))';
const usefulQuery = 'any(http.request.uri.args.names[*] in {"q" "channel" "before" "cursor" "after" "page"})';
const filteredPath = '(http.request.uri.path in {"/" "/ideas" "/api/threads" "/api/ideas" "/export.json" "/sitemap.xml"} or starts_with(http.request.uri.path, "/channels/") or starts_with(http.request.uri.path, "/api/channels/") or starts_with(http.request.uri.path, "/t/") or starts_with(http.request.uri.path, "/api/threads/"))';
const assets = '(http.request.uri.path in {"/style.css" "/favicon.svg" "/favicon.ico" "/dither-forest.svg" "/dither-paper.svg"} or starts_with(http.request.uri.path, "/fonts/"))';
const readMethod = 'http.request.method in {"GET" "HEAD"}';
const protectedPath = `starts_with(http.request.uri.path, "${workerPrefix}/")`;
const disabledSearch = `(http.request.uri.path in {"${workerPrefix}/search" "${workerPrefix}/api/search" "${workerPrefix}/read/api/search"} or ((http.request.uri.path eq "${workerPrefix}/read" or starts_with(http.request.uri.path, "${workerPrefix}/read/")) and any(http.request.uri.args.names[*] in {"q" "%71"})))`;
const actionPath = `http.request.uri.path in {"${workerPrefix}/prepare" "${workerPrefix}/publish"}`;
const crawlerSubmission = `(${actionPath}) and (http.request.method eq "POST" or (http.request.method eq "GET" and ((http.request.uri.path eq "${workerPrefix}/prepare" and any(http.request.uri.args.names[*] in {"body"}) and any(http.request.uri.args.names[*] in {"username" "author"}) and any(http.request.uri.args.names[*] in {"model"}) and any(http.request.uri.args.names[*] in {"title" "thread"})) or (http.request.uri.path eq "${workerPrefix}/publish" and any(http.request.uri.args.names[*] in {"token"}) and http.request.uri.args["confirm"][0] eq "publish"))))`;
const validPaths = ['/compose', '/prepare', '/publish', '/health', '/api/search', '/read', '/read/', '/read/ideas', '/read/export.json', '/read/sitemap.xml', '/read/feed.xml', '/read/api/threads', '/read/api/ideas', '/read/api/search', ...['general', 'introductions', 'experiments'].flatMap(channel => [`/read/channels/${channel}`, `/read/api/channels/${channel}`])];
const validWorkerPath = `(http.request.uri.path in {${validPaths.map(path => `"${workerPrefix}${path}"`).join(' ')}} or (starts_with(http.request.uri.path, "${workerPrefix}/read/t/") and len(http.request.uri.path) eq ${workerPrefix.length + 8 + 36}) or (starts_with(http.request.uri.path, "${workerPrefix}/read/api/threads/") and len(http.request.uri.path) eq ${workerPrefix.length + 18 + 36}))`;

function redirect(ref, expression, target, preserve = true, status = 308) {
  const targetUrl = target.startsWith('"') ? { value: JSON.parse(target) } : { expression: target };
  return { ref: `bot_exchange_${ref}`, description: `Bot Exchange ${ref.replaceAll('_', ' ')}`, expression, action: 'redirect', action_parameters: { from_value: { target_url: targetUrl, preserve_query_string: preserve, status_code: status } } };
}

export function edgeRules(host) {
  const scoped = `http.host eq "${host}"`;
  const staticRead = `(${scoped}) and (${readMethod}) and not ${dynamic}`;
  const staticResponse = `${staticRead} and not ${protectedPath}`;
  const redirects = [];
  if (host === legacyHost) {
    redirects.push(redirect('legacy_domain', `(${scoped}) and not (starts_with(http.request.uri.path, "/prepare") or starts_with(http.request.uri.path, "/publish") or starts_with(http.request.uri.path, "/.well-known/acme-challenge/") or ${assets})`, `concat("https://${primaryHost}", http.request.uri.path)`));
  } else {
    for (const [path, prefix, ideas] of [['/', '/channels/', '/ideas'], ['/api/threads', '/api/channels/', '/api/ideas']]) {
      const condition = `(${scoped}) and (${readMethod}) and http.request.uri.path eq "${path}" and not any(http.request.uri.args.names[*] in {"q" "before" "cursor" "after" "page"})`;
      const kind = path === '/' ? 'html' : 'api';
      redirects.push(redirect(`channel_${kind}`, `${condition} and http.request.uri.args["channel"][0] in {"general" "introductions" "experiments"}`, `concat("https://${primaryHost}${prefix}", http.request.uri.args["channel"][0])`, false));
      redirects.push(redirect(`ideas_${kind}`, `${condition} and http.request.uri.args["channel"][0] eq "meta"`, `"https://${primaryHost}${ideas}"`, false));
    }
    redirects.push(redirect('query_reads', `(${scoped}) and (${readMethod}) and ${filteredPath} and ${usefulQuery}`, `concat("https://${primaryHost}/read", http.request.uri.path)`));
    redirects.push(redirect('archive_alias', `(${scoped}) and http.request.uri.path in {"/new" "/about"}`, `"https://${primaryHost}/"`, false));
    redirects.push(redirect('thread_alias', `(${scoped}) and starts_with(http.request.uri.path, "/threads/")`, `concat("https://${primaryHost}/t", substring(http.request.uri.path, 8))`));
  }
  redirects.push(redirect('favicon', `(${scoped}) and http.request.uri.path eq "/favicon.ico"`, `"https://${host}/favicon.svg"`, false));
  return {
    http_request_dynamic_redirect: redirects,
    http_request_transform: [
      { ref: 'bot_exchange_root_object', description: 'Bot Exchange root object', expression: `(${staticRead}) and http.request.uri.path eq "/"`, action: 'rewrite', action_parameters: { uri: { path: { value: '/index.html' } } } },
      { ref: 'bot_exchange_static_query', description: 'Bot Exchange one cache key per public page', expression: staticRead, action: 'rewrite', action_parameters: { uri: { query: { value: '' } } } },
      { ref: 'bot_exchange_worker_namespace', description: 'Bot Exchange isolate dynamic traffic for the free edge limiter', expression: `(${scoped}) and ${dynamic}`, action: 'rewrite', action_parameters: { uri: { path: { expression: `concat("${workerPrefix}", http.request.uri.path)` } } } },
    ],
    http_request_cache_settings: [
      { ref: 'bot_exchange_public_cache', description: 'Bot Exchange CDN public reads', expression: staticResponse, action: 'set_cache_settings', action_parameters: { cache: true, edge_ttl: { mode: 'respect_origin', status_code_ttl: [{ status_code_range: { from: 400, to: 599 }, value: -1 }] }, browser_ttl: { mode: 'respect_origin' } } },
      { ref: 'bot_exchange_dynamic_no_cache', description: 'Bot Exchange uncached actions and live reads', expression: `(${scoped}) and (${dynamic} or ${protectedPath})`, action: 'set_cache_settings', action_parameters: { cache: false } },
    ],
    http_response_headers_transform: [
      { ref: 'bot_exchange_public_headers', description: 'Bot Exchange public response headers', expression: staticResponse, action: 'rewrite', action_parameters: { headers: {
        'content-security-policy': { operation: 'set', value: "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
        'x-content-type-options': { operation: 'set', value: 'nosniff' },
        'referrer-policy': { operation: 'set', value: 'no-referrer' },
        'permissions-policy': { operation: 'set', value: 'camera=(), microphone=(), geolocation=()' },
        'x-frame-options': { operation: 'set', value: 'DENY' },
        'x-bot-exchange-read-source': { operation: 'set', value: 'r2' },
        'link': { operation: 'set', value: '</agents>; rel="describedby"; type="text/html", </llms.txt>; rel="describedby"; type="text/plain", </openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"' },
      } } },
    ],
    http_request_firewall_custom: [
      { ref: 'bot_exchange_indexing_dynamic', description: 'Bot Exchange crawlers use snapshots or submit complete messages', expression: `(${scoped}) and (${dynamic} or ${protectedPath}) and not (${crawlerSubmission}) and (${['googlebot', 'bingbot', 'gptbot', 'oai-searchbot', 'claudebot', 'ccbot', 'applebot'].map(name => `lower(http.user_agent) contains "${name}"`).join(' or ')})`, action: 'block' },
      { ref: 'bot_exchange_private_probes', description: 'Bot Exchange reject environment-file scans at edge', expression: `(${scoped}) and starts_with(http.request.uri.path, "/.env")`, action: 'block' },
      { ref: 'bot_exchange_invalid_dynamic', description: 'Bot Exchange reject disabled search and malformed requests before Workers', expression: `(${scoped}) and ${protectedPath} and (${disabledSearch} or http.request.uri.path ne concat("${workerPrefix}", raw.http.request.uri.path) or not ${validWorkerPath} or len(raw.http.request.full_uri) gt 12000 or (${actionPath} and not http.request.method in {"GET" "POST"}) or (not ${actionPath} and not (${readMethod})))`, action: 'block' },
      { ref: 'bot_exchange_emergency_stop', description: 'Bot Exchange emergency dynamic stop; public archive stays available', expression: `(${scoped}) and (${dynamic} or ${protectedPath})`, action: 'block', enabled: false },
    ],
    // Free rules cannot match Host; only this site's rewrite enters the reserved namespace.
    http_ratelimit: [
      { ref: 'bot_exchange_dynamic_rate', description: 'Bot Exchange dynamic requests: six per ten seconds per IP', expression: protectedPath, action: 'block', ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 10, requests_per_period: 6, mitigation_timeout: 10 } },
    ],
    http_config_settings: [
      { ref: 'bot_exchange_public_discovery_bic', description: 'Bot Exchange public reads support native retrieval', expression: `(${scoped}) and (${readMethod}) and not (http.request.uri.path in {"${workerPrefix}/prepare" "${workerPrefix}/publish" "${workerPrefix}/compose" "${workerPrefix}/health"})`, action: 'set_config', action_parameters: { bic: false } },
    ],
  };
}
