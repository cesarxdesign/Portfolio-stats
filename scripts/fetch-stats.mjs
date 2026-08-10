// Fetches filtered site stats from PostHog and writes public/data/latest.json
// plus a dated snapshot. Runs in GitHub Actions daily (~4am Europe/Lisbon).
// Requires: POSTHOG_API_KEY (personal API key, query:read scope).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ID = 235837;
const API_HOST = 'https://eu.posthog.com';
const API_KEY = process.env.POSTHOG_API_KEY;
if (!API_KEY) {
  console.error('POSTHOG_API_KEY is not set');
  process.exit(1);
}

// The standard traffic filter. Applied to EVERY number, always:
// no flagged bots, no Portugal (own traffic), no datacenter cities,
// no 1920x1080-exact viewports (headless Chrome fingerprint).
const FILTER = `
  AND NOT coalesce(properties.$virt_is_bot, false)
  AND coalesce(properties.$geoip_country_code, '') != 'PT'
  AND coalesce(properties.$geoip_city_name, '') NOT IN ('Boydton', 'Dulles', 'Paris', 'Amsterdam')
  AND NOT (coalesce(properties.$viewport_width, 0) = 1920 AND coalesce(properties.$viewport_height, 0) = 1080)`;

// Complete days only: [today-30d 00:00 UTC, today 00:00 UTC)
const WINDOW_30D = `timestamp >= toStartOfDay(now()) - INTERVAL 30 DAY AND timestamp < toStartOfDay(now())`;
const WINDOW_7D = `timestamp >= toStartOfDay(now()) - INTERVAL 7 DAY AND timestamp < toStartOfDay(now())`;

const CUSTOM_EVENTS = ['project_open', 'outbound_click', 'section_view', 'scroll_depth'];

async function hogql(query) {
  const res = await fetch(`${API_HOST}/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) {
    throw new Error(`PostHog query failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  const columns = json.columns;
  return (json.results ?? []).map((row) =>
    Object.fromEntries(columns.map((c, i) => [c, row[i]]))
  );
}

const dailyRows = await hogql(`
  SELECT toDate(timestamp) AS day, uniq(person_id) AS visitors, count() AS pageviews
  FROM events
  WHERE event = '$pageview' AND ${WINDOW_30D} ${FILTER}
  GROUP BY day ORDER BY day`);

const totalsRows = await hogql(`
  SELECT
    uniqIf(person_id, timestamp >= toStartOfDay(now()) - INTERVAL 7 DAY) AS visitors_7d,
    countIf(timestamp >= toStartOfDay(now()) - INTERVAL 7 DAY) AS pageviews_7d,
    uniqIf(person_id, timestamp >= toStartOfDay(now()) - INTERVAL 14 DAY AND timestamp < toStartOfDay(now()) - INTERVAL 7 DAY) AS visitors_prev7d,
    countIf(timestamp >= toStartOfDay(now()) - INTERVAL 14 DAY AND timestamp < toStartOfDay(now()) - INTERVAL 7 DAY) AS pageviews_prev7d,
    uniq(person_id) AS visitors_30d,
    count() AS pageviews_30d
  FROM events
  WHERE event = '$pageview' AND ${WINDOW_30D} ${FILTER}`);

const pagesRows = await hogql(`
  SELECT coalesce(properties.$pathname, '?') AS path, count() AS pageviews, uniq(person_id) AS visitors
  FROM events
  WHERE event = '$pageview' AND ${WINDOW_7D} ${FILTER}
  GROUP BY path ORDER BY pageviews DESC LIMIT 12`);

const sourcesRows = await hogql(`
  SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source,
         uniq(person_id) AS visitors, count() AS pageviews
  FROM events
  WHERE event = '$pageview' AND ${WINDOW_7D}
    AND coalesce(properties.$referring_domain, '') != coalesce(properties.$host, '') ${FILTER}
  GROUP BY source ORDER BY visitors DESC, pageviews DESC LIMIT 12`);

const eventsRows = await hogql(`
  SELECT event, count() AS hits, uniq(person_id) AS visitors
  FROM events
  WHERE event IN (${CUSTOM_EVENTS.map((e) => `'${e}'`).join(', ')}) AND ${WINDOW_7D} ${FILTER}
  GROUP BY event ORDER BY hits DESC`);

// Dense-fill the daily series: every one of the 30 complete days, zeros included.
const byDay = new Map(dailyRows.map((r) => [r.day, r]));
const daily = [];
const end = new Date(); // walk backward from yesterday (UTC), 30 days
end.setUTCHours(0, 0, 0, 0);
for (let i = 30; i >= 1; i--) {
  const d = new Date(end.getTime() - i * 86400000);
  const key = d.toISOString().slice(0, 10);
  const row = byDay.get(key);
  daily.push({ day: key, visitors: row?.visitors ?? 0, pageviews: row?.pageviews ?? 0 });
}

const events = CUSTOM_EVENTS.map((name) => {
  const row = eventsRows.find((r) => r.event === name);
  return { event: name, hits: row?.hits ?? 0, visitors: row?.visitors ?? 0 };
}).sort((a, b) => b.hits - a.hits);

const data = {
  generated_at: new Date().toISOString(),
  data_through: daily[daily.length - 1].day,
  totals: totalsRows[0],
  daily,
  top_pages: pagesRows,
  sources: sourcesRows,
  events,
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'public', 'data');
mkdirSync(dataDir, { recursive: true });

const lisbonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
const payload = JSON.stringify(data, null, 2) + '\n';
writeFileSync(join(dataDir, 'latest.json'), payload);
writeFileSync(join(dataDir, `${lisbonDate}.json`), payload);
console.log(`Snapshot written: data through ${data.data_through}, ${data.totals.visitors_7d} visitors last 7 days`);
