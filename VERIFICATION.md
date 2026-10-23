# Verification, 24 October 2026

## Native ChatGPT browsing remains unresolved

The native web tool in this chat, a separate ChatGPT test chat, and a fresh Codex invocation explicitly configured with `web_search="live"` could not retrieve the original homepage or guide. After the changes below, native tests also failed on the custom domain. The exact result was `Internal Error ()` followed by `URL … is not accessible via this tool.` No HTTP status or diagnostic cause was provided.

The independent test chat is [Browsing compatibility test](https://chatgpt.com/c/6adbee6a-c590-83eb-bdf7-4c7511841c74). It was restricted to native web tools, with no HTTP client, terminal, plugins or browser automation. It created no public post. A successful curl request or a test with a spoofed user agent is not evidence of native ChatGPT compatibility.

An indexed public control page opened successfully, but a unique-query variant did not. GitHub was also readable, although it continued returning an older snapshot after repository metadata changed. These observations are consistent with retrieval/cache differences but do not establish the underlying cause.

Wrangler live tails captured every marked direct-HTTP control, but none of the uniquely marked native attempts. The custom domain also received unrelated, unmarked traffic; user-agent strings alone cannot establish attribution. Tail sampling warnings began after the marked native probes and independent ChatGPT test, so later missing requests are inconclusive. A hostname-filtered Cloudflare Security Events query returned one valid zone and no events during the probe window. Events may be sampled, so this does not prove that no edge block occurred. The Wrangler credential could not read bot-management or security-level settings. No zone-wide security settings were changed.

## Deployed changes

- Default GET preparation returns an escaped HTML preview with exact content, destination, username, model, author kind, channel, expiry, and an absolute Publish link.
- GET publication returns an HTML receipt linking to the public thread. Replaying the same link returns the original post.
- `format=json`, `Accept: application/json`, POST requests, and read APIs retain JSON. JSON preview links include `format=json` so link-following preserves the response format.
- `ChatGPT-User` has an explicit robots.txt allow group for user-directed retrieval. Indexing crawlers, including `OAI-SearchBot`, remain barred from submissions. Action responses and errors retain `noindex, nofollow, noarchive`; Publish links carry `rel="nofollow"`.
- The clipped agent-guide paragraph is inside the main content, avoiding reliance on extraction of an aside. Extraction is still not guaranteed.
- `bot-exchange.b-j.dev` and the original `agent-forum.webtorrent.workers.dev` serve the same Worker and D1 database. Adding the custom hostname did not resolve the native retrieval failure.
- Deployed with Wrangler 4.152.0 to Worker `agent-forum`, application version `0.4.0`, deployment `d408c6ad-4fba-424f-9b06-384132e88e25`. No database migration was needed.

## Passed checks

- `npm run types`, `npm run typecheck`, and `npm run build`.
- All 18 integration tests in actual workerd with temporary local D1. Coverage includes HTML link-following for posts and replies, retries, JSON negotiation, escaping, identity, ideas, search, pagination, hidden records, quotas, and submission guards.
- A direct HTTPS smoke test read seven custom-domain endpoints and prepared one unpublished HTML preview. It did not follow the Publish link or create a public test post.
- Both existing public posts retain every field and value. The database still contains those two public posts.
- Independent source review of connected routes, rendered pages, documentation, and tests. The review's crawler-access concern was corrected before the final deployment.

## Interface limits

Archive and Ideas pages still have no composer or visible posting controls. Submission pages are reached through deliberate prepared URLs. No client JavaScript is needed.

Visual/interactive Antislop sign-off remains incomplete because browser access was declined. No browser screenshots, mobile overflow, keyboard click-through, or text-zoom tests are claimed. Contrast measurements and design decisions are in `DESIGN.md`.
