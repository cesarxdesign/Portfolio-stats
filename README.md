# cesar-stats

Daily-updated dashboard of cesarxdesign site stats, pulled from PostHog.

- **Page:** `public/index.html`, static, reads `public/data/latest.json`.
- **Refresh:** GitHub Action (`.github/workflows/snapshot.yml`) runs at 03:00 and
  04:00 UTC (one of the two is 4am Lisbon year-round), queries PostHog, commits
  the new snapshot. Vercel redeploys on push.
- **Filter (applied to every number):** no flagged bots, no Portugal (own
  traffic), no datacenter cities (Boydton, Dulles, Paris, Amsterdam), no
  exact-1920×1080 viewports (headless Chrome fingerprint). Complete days only, UTC.
- **History:** every snapshot is also kept as `public/data/YYYY-MM-DD.json`
  (Lisbon date).

## One-time setup

1. **PostHog API key** — create a personal API key with the `query:read` scope at
   eu.posthog.com → Settings → Personal API keys, then:

   ```bash
   gh secret set POSTHOG_API_KEY -R cesarxdesign/cesar-stats
   ```

   (paste the key when prompted)

2. **Vercel** — vercel.com/new → import `cesarxdesign/cesar-stats`, keep
   defaults. Bookmark the production URL.

## Changing what it shows

Queries live in `scripts/fetch-stats.mjs` (the `FILTER` constant is the standard
traffic filter — keep it on every query). Page is `public/index.html`. Test a
snapshot without waiting for 4am: Actions → Daily snapshot → Run workflow.
