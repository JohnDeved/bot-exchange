# Search cache accounting experiment

Status: deferred at the user's request; prepared locally, not deployed. Search is temporarily disabled in production. No verified quota saving from this experiment.

The cost requirement is fewer **metered Worker requests**, not just fewer D1 queries or CPU executions. Workers Cache explicitly bills hits as requests. Pages documents a different ordering: custom-domain CDN cache responses can be served before Pages Functions. Test whether these hits are excluded from the Function request count before considering a search migration.

## Isolation

- Use only the existing account `19321bcee0ed17a93b709cb602dd070c`.
- Temporary Pages project: `bot-exchange-search-cache-probe`.
- Temporary hostname: `search-cache-probe.objekt.stream`, zone `8388b78290a151b12e0273c6468f9421`.
- No database, R2, secrets, service bindings, or production messages.
- The two test routes return generated execution IDs; there is no application-side cache.
- Do not enable Workers Cache. Do not use another account or plan to evade the shared quota.
- Deploy immediately before the measurement and remove the project, hostname and test cache rule afterward. A Pages-generated hostname would otherwise leave an unnecessary Function invocation surface outside the site's WAF.

The account was exhausted earlier on 24 October 2026; the user then upgraded to Workers Paid and runtime service recovered. The runner retains its conservative **2026-10-25 00:00 UTC** guard from preparation. Do not run it automatically: the user postponed search work. Reassess current plan and accounting before resuming this experiment.

## Local verification

From the repository root:

```sh
node --test ops/search-cache-probe/*.test.mjs
node --check ops/search-cache-probe/run.mjs
```

## Deployment and measurement

Use the repository's installed Wrangler, with `ops/search-cache-probe` as its working directory. Read the current help before deployment if the version changes.

1. Create the isolated Pages project using `../../node_modules/.bin/wrangler pages project create bot-exchange-search-cache-probe --production-branch main --compatibility-date 2026-10-24`.
2. Deploy `public/` using `../../node_modules/.bin/wrangler pages deploy public --project-name bot-exchange-search-cache-probe --branch main`. Set the project's production `fail_open` to false: a static fallback must not masquerade as a successful Function response.
3. Add the custom domain through the Pages API; create its proxied CNAME to `bot-exchange-search-cache-probe.pages.dev` if absent. Wait for domain and certificate validation.
4. Merge `cacheRule` from `edge-rule.mjs` into the zone's existing `http_request_cache_settings` entrypoint. Preserve all other rules. Do not change the cache key or strip the `q` query parameter. Confirm no Worker route intercepts the probe hostname. The site's existing zone rate limiter matches `/_bot-exchange/`, so the runner spaces requests by 2.2 seconds.
5. Read the project's `production_script_name`. Record a baseline of its Function request metrics. Attach Wrangler `pages deployment tail --project-name bot-exchange-search-cache-probe --environment production --format json --sampling-rate 1` and save the output outside the repository. Wait for the tail to connect before generating traffic.
6. Run the experiment once from the repository root:

   ```sh
   node ops/search-cache-probe/run.mjs https://search-cache-probe.objekt.stream /ABSOLUTE/WORK/PATH/search-cache-probe-results.json
   ```

7. Reconcile the exact interval and execution IDs with logs and Function request metrics after aggregation. Do not infer billing from cached response bodies alone. GraphQL adaptive sampling can make a small test inconclusive; missing sampled events are not proof of zero requests. If the available metrics cannot distinguish seven requests from 27, mark accounting **unverified**.
8. Delete the temporary project, the DNS record created for this experiment, and only the cache rule with ref `bot_exchange_pages_search_probe`. Remove any domain attachment left behind. Keep the recorded evidence.

## Acceptance

| Group | HTTP requests | Expected executions | Expected cache hits |
| --- | ---: | ---: | ---: |
| Cached query A | 11 | 1 | 10 |
| Cached query B | 11 | 1 | 10 |
| Uncached control | 5 | 5 | 0 |
| Total | 27 | 7 | 20 |

Pass only when query A and B remain distinct, warm results preserve each query's execution ID, controls produce five fresh IDs, and Function request accounting excludes the 20 hits. If all 27 requests are metered, this approach fails the cost requirement even if only seven executions occur. A pass proves this small controlled cache test; real search still needs native-tool, query normalization, abuse protection, freshness, and public-result correctness checks.

## Sources

- [Pages cache ordering](https://developers.cloudflare.com/pages/configuration/serving-pages/#caching-and-performance)
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Workers Cache request billing](https://developers.cloudflare.com/workers/cache/#pricing)
- [Reported Pages/Worker cache-order difference](https://github.com/cloudflare/cloudflare-docs/issues/20445), an unconfirmed user report rather than an official guarantee.
