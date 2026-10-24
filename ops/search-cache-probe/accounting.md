# Canary accounting — deferred

Read-only GraphQL schema validation completed on 2026-10-24. No canary was deployed or requested. The Pages project `bot-exchange-search-cache-probe` returned 404. Work stopped when the user prioritized disabling search and reviewing bot traffic.

After any future deployment, obtain the exact `production_script_name` from `GET /accounts/19321bcee0ed17a93b709cb602dd070c/pages/projects/bot-exchange-search-cache-probe`; do not guess its generated ID.

The following query was accepted by the live GraphQL endpoint using a nonexistent script name, returning empty arrays. Both datasets are enabled on the account. Submit it read-only to `POST https://api.cloudflare.com/client/v4/graphql` with account, actual script name, and a fixed UTC test window. Use the same window on subsequent reads, allowing several minutes for delayed metrics. Keep the project otherwise idle. These datasets cannot filter by test query string or hostname.

```graphql
query ProbeAccounting(
  $accountTag: string!
  $scriptName: string!
  $start: Time!
  $end: Time!
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      pages: pagesFunctionsInvocationsAdaptiveGroups(
        limit: 100
        filter: {scriptName: $scriptName, datetime_geq: $start, datetime_lt: $end}
      ) {
        dimensions {scriptName status}
        sum {requests errors}
        avg {sampleInterval}
        confidence(level: 0.99) {
          sum {requests {estimate lower upper sampleSize isValid}}
        }
      }
      workers: workersInvocationsAdaptive(
        limit: 100
        filter: {scriptName: $scriptName, datetime_geq: $start, datetime_lt: $end}
      ) {
        dimensions {scriptName status cacheStatus}
        sum {requests errors}
        avg {sampleInterval}
        confidence(level: 0.99) {
          sum {requests {estimate lower upper sampleSize isValid}}
        }
      }
    }
  }
}
```

For the prepared 27-request run, expected response evidence is 20 CDN HITs and seven distinct execution IDs. Reconcile this with seven Function requests after metrics settle. Sum rows within each dataset separately; never add the Pages and Workers datasets together. Record all statuses, including errors. A quiet baseline window helps detect stray traffic, but does not replace the exact run interval. The script is dedicated to the probe because neither invocation dataset can distinguish paths or run IDs.

Both datasets explicitly use adaptive sampling. Record `avg.sampleInterval` and request confidence/sample counts. Estimates, invalid intervals, missing rows, delayed data, or non-unit sample intervals do not prove an exact seven-versus-27 count. Even an exact seven in invocation analytics is usage evidence, not a contractual billing guarantee; retain `billingVerified: false` until independently reconciled with the relevant usage meter. Twenty response HITs and seven execution IDs alone prove response reuse, not lower request metering.

Only the Workers dataset exposes `dimensions.cacheStatus`, described by the live schema as cache status for a cache-enabled Worker invocation. This is the new Workers Cache feature, whose hits still count as Worker requests; it is not a documented meter for Pages custom-domain CDN HITs. Pages has no cache-hit dimension in its invocation schema.

Sources: [Pages Functions metrics](https://developers.cloudflare.com/pages/functions/metrics/), [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/), [GraphQL datasets and adaptive sampling](https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/), [Workers Cache pricing](https://developers.cloudflare.com/workers/cache/#pricing).
