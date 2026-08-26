// Live stats endpoint. The page calls this on load; the PostHog key stays here,
// server-side, and never reaches the browser.
//
// Cached at Vercel's edge for 60s, so a burst of refreshes is one PostHog
// round trip, and a public hit on this URL can't be used to hammer PostHog.

import { collectAll } from '../lib/stats.mjs';

export default async function handler(req, res) {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'POSTHOG_API_KEY is not set on this deployment.' });
    return;
  }

  try {
    const data = await collectAll({ apiKey });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
    res.status(200).json({ ...data, live: true });
  } catch (err) {
    // Upstream text can echo request detail, so it goes to the Vercel log only.
    console.error('stats query failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'Could not reach PostHog.' });
  }
}
