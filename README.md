# cesar-stats

Daily-updated dashboard of cesarxdesign site stats, pulled from PostHog.

- **Page:** `public/index.html`, static, reads `public/data/latest.json`.
- **Refresh:** GitHub Action (`.github/workflows/snapshot.yml`) runs at 03:00 and
  04:00 UTC (one of the two is 4am Lisbon year-round), queries PostHog, commits
  the new snapshot. Vercel redeploys on push.
- **Filter (applied to every number):** no flagged bots, no datacenter cities
  (Boydton, Dulles, Paris, Amsterdam), no exact-1920×1080 viewports (headless
  Chrome fingerprint). Complete days only, UTC.
- **Portugal (own traffic):** excluded by default, but the page has an *Include
  Portugal* switch, so every figure is computed twice and shipped as
  `views.clean` / `views.with_pt`.
- **Date ranges:** the page's dropdown picks from `views.<variant>.windows` —
  rolling `d1`…`d7` and `d30` ("Last month"), complete days only. Tiles, top
  pages, sources, countries and interactions all follow the selected range; the
  daily chart always shows the full 30 days.
- **History:** every snapshot is also kept as `public/data/YYYY-MM-DD.json`
  (Lisbon date).

## One-time setup

1. **PostHog API key** — done (2026-08-10): `POSTHOG_API_KEY` repo secret is set.
   If the key is ever rotated:

   ```bash
   gh secret set POSTHOG_API_KEY -R cesarxdesign/cesar-stats
   ```

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
