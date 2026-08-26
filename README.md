# cesar-stats

Daily-updated dashboard of cesarxdesign site stats, pulled from PostHog.

- **Page:** `public/index.html`, static. On load it calls `/api/stats` and
  renders whatever PostHog has up to that second. If that call fails it falls
  back to the committed `public/data/latest.json` and says so in the header.
- **Live endpoint:** `api/stats.mjs`, a Vercel Serverless Function. It holds
  `POSTHOG_API_KEY` server-side — the key never reaches the browser — and its
  response is edge-cached for 60s, so a burst of refreshes is one PostHog round
  trip and the public URL can't be used to hammer PostHog.
- **Archive:** GitHub Action (`.github/workflows/snapshot.yml`) runs daily,
  writing the dated history files and refreshing the fallback. It is no longer
  what the page reads.
- **Shared logic:** `lib/stats.mjs` builds the payload and is imported by both
  the endpoint and the Action, so live and archived numbers are built by
  identical code.
- **Filter (applied to every number):** no flagged bots, no datacenter cities
  (Boydton, Dulles, Paris, Amsterdam), no exact-1920×1080 viewports (headless
  Chrome fingerprint).
- **Portugal (own traffic):** excluded by default, but the page has an *Include
  Portugal* switch, so every figure is computed twice and shipped as
  `views.clean` / `views.with_pt`.
- **Date ranges:** the page's dropdown picks from `views.<variant>.windows` —
  rolling `d1`…`d7` and `d30` ("Last month"). A range of N days means today so
  far plus the N-1 complete days before it, all UTC; deltas compare against the
  N complete days preceding that. Tiles, top pages, sources, countries and
  interactions all follow the selected range; the daily chart always shows 30
  days ending today, with today's column drawn faded because it is partial.
- **Visits per page:** `views.<variant>.pages_table` — every path ever seen,
  with all-time totals and a per-range breakdown hung off `w`. The pages query
  scans from the project's first event so one pass serves both.
- **History:** every snapshot is also kept as `public/data/YYYY-MM-DD.json`
  (Lisbon date).

## One-time setup

1. **PostHog API key, twice.** GitHub (for the daily archive) and Vercel (for
   the live endpoint) each need their own copy.

   - GitHub — done (2026-08-10). If the key is ever rotated:

     ```bash
     gh secret set POSTHOG_API_KEY -R cesarxdesign/cesar-stats
     ```

   - Vercel — Project → Settings → Environment Variables → add
     `POSTHOG_API_KEY` for Production (and Preview), then redeploy. Until this
     is set, `/api/stats` answers 503 and the page quietly serves the last
     daily snapshot instead.

2. **Vercel** — vercel.com/new → import `cesarxdesign/cesar-stats`, keep
   defaults. Bookmark the production URL.

## Changing what it shows

Queries live in `scripts/fetch-stats.mjs`. `BOTS` is the standard traffic filter
and `NO_PT` the Portugal one — keep `BOTS` on every query. Ranges come from the
`WINDOWS` array; adding one there flows through to the page's dropdown, which
builds its own matching `RANGES` list. Page is `public/index.html`.

Check the generated HogQL without a key in hand:

```bash
PRINT_SQL=1 node scripts/fetch-stats.mjs
```

Test a snapshot without waiting for 4am: Actions → Daily snapshot → Run workflow,
or `gh workflow run snapshot.yml -R cesarxdesign/cesar-stats`.
