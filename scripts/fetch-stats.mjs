// Fetches filtered site stats from PostHog and writes public/data/latest.json
// plus a dated snapshot. Runs in GitHub Actions daily (~4am Europe/Lisbon).
// Requires: POSTHOG_API_KEY (personal API key, query:read scope).
//
// Every figure is precomputed for each date range in WINDOWS, twice: once with
// Portugal excluded (the default view) and once with it counted in. The page
// only switches between prepared numbers, it never aggregates.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ID = 235837;
const API_HOST = 'https://eu.posthog.com';
const API_KEY = process.env.POSTHOG_API_KEY;
// PRINT_SQL=1 dumps the generated HogQL and runs no queries, so the SQL can be
// checked against PostHog without a key in hand.
const PRINT_SQL = process.env.PRINT_SQL === '1';
if (!API_KEY && !PRINT_SQL) {
  console.error('POSTHOG_API_KEY is not set');
  process.exit(1);
}

// The standard traffic filter, always applied: no flagged bots, no datacenter
// cities, no 1920x1080-exact viewports (headless Chrome fingerprint).
const BOTS = `
  AND NOT coalesce(properties.$virt_is_bot, false)
  AND coalesce(properties.$geoip_city_name, '') NOT IN ('Boydton', 'Dulles', 'Paris', 'Amsterdam')
  AND NOT (coalesce(properties.$viewport_width, 0) = 1920 AND coalesce(properties.$viewport_height, 0) = 1080)`;

// Portugal is his own traffic: out by default, toggleable back in on the page.
const NO_PT = `
  AND coalesce(properties.$geoip_country_code, '') != 'PT'`;

// Selectable date ranges. Rolling, complete days only. d30 is "Last month".
const WINDOWS = [1, 2, 3, 4, 5, 6, 7, 30].map((days) => ({ key: `d${days}`, days }));
const LONGEST = 30;

// Complete days only: [today-N 00:00 UTC, today 00:00 UTC), and the equal-length
// period immediately before it, for the deltas.
const inW = (n) => `timestamp >= toStartOfDay(now()) - INTERVAL ${n} DAY AND timestamp < toStartOfDay(now())`;
const inPrev = (n) =>
  `timestamp >= toStartOfDay(now()) - INTERVAL ${2 * n} DAY AND timestamp < toStartOfDay(now()) - INTERVAL ${n} DAY`;

const CUSTOM_EVENTS = ['project_open', 'outbound_click', 'section_view', 'scroll_depth'];

let printed = 0;
const perWindow = (fn) => WINDOWS.map(fn).join(',\n    ');

async function hogql(query) {
  if (PRINT_SQL) {
    console.log(`\n-- ${++printed} --${query}`);
    return [];
  }
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

// A grouped list (pages / sources / countries) sliced per window: one query
// returns every window as its own pair of columns, sorted and trimmed here.
function sliceList(rows, nameKey, sortBy) {
  const out = {};
  for (const w of WINDOWS) {
    out[w.key] = rows
      .map((r) => ({ [nameKey]: r[nameKey], pageviews: r[`p_${w.key}`], visitors: r[`v_${w.key}`] }))
      .filter((r) => r.pageviews > 0)
      .sort((a, b) => b[sortBy] - a[sortBy] || b.pageviews - a.pageviews)
      .slice(0, 12);
  }
  return out;
}

// One complete set of figures under a given traffic filter.
async function collect(FILTER) {
  const totalsRows = await hogql(`
    SELECT
    ${perWindow((w) =>
      `uniqIf(person_id, ${inW(w.days)}) AS v_${w.key},
    countIf(${inW(w.days)}) AS p_${w.key},
    uniqIf(person_id, ${inPrev(w.days)}) AS pv_${w.key},
    countIf(${inPrev(w.days)}) AS pp_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${inW(2 * LONGEST)} ${FILTER}`);
  const tot = totalsRows[0] ?? {};

  const dailyRows = await hogql(`
    SELECT toDate(timestamp) AS day, uniq(person_id) AS visitors, count() AS pageviews
    FROM events
    WHERE event = '$pageview' AND ${inW(LONGEST)} ${FILTER}
    GROUP BY day ORDER BY day`);

  const pagesRows = await hogql(`
    SELECT coalesce(properties.$pathname, '?') AS path,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${inW(LONGEST)} ${FILTER}
    GROUP BY path LIMIT 200`);

  const sourcesRows = await hogql(`
    SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${inW(LONGEST)}
      AND coalesce(properties.$referring_domain, '') != coalesce(properties.$host, '') ${FILTER}
    GROUP BY source LIMIT 200`);

  const countriesRows = await hogql(`
    SELECT coalesce(nullIf(properties.$geoip_country_name, ''), 'Unknown') AS country,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${inW(LONGEST)} ${FILTER}
    GROUP BY country LIMIT 200`);

  const eventsRows = await hogql(`
    SELECT event,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS h_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event IN (${CUSTOM_EVENTS.map((e) => `'${e}'`).join(', ')}) AND ${inW(LONGEST)} ${FILTER}
    GROUP BY event`);

  // Dense-fill the daily series: every one of the 30 complete days, zeros included.
  const byDay = new Map(dailyRows.map((r) => [r.day, r]));
  const daily = [];
  const end = new Date(); // walk backward from yesterday (UTC), 30 days
  end.setUTCHours(0, 0, 0, 0);
  for (let i = LONGEST; i >= 1; i--) {
    const d = new Date(end.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    daily.push({ day: key, visitors: row?.visitors ?? 0, pageviews: row?.pageviews ?? 0 });
  }

  const pages = sliceList(pagesRows, 'path', 'pageviews');
  const sources = sliceList(sourcesRows, 'source', 'visitors');
  const countries = sliceList(countriesRows, 'country', 'visitors');

  const windows = {};
  for (const w of WINDOWS) {
    windows[w.key] = {
      totals: {
        visitors: tot[`v_${w.key}`],
        pageviews: tot[`p_${w.key}`],
        prev_visitors: tot[`pv_${w.key}`],
        prev_pageviews: tot[`pp_${w.key}`],
      },
      top_pages: pages[w.key],
      sources: sources[w.key],
      countries: countries[w.key],
      events: CUSTOM_EVENTS.map((name) => {
        const row = eventsRows.find((r) => r.event === name);
        return { event: name, hits: row?.[`h_${w.key}`] ?? 0, visitors: row?.[`v_${w.key}`] ?? 0 };
      }).sort((a, b) => b.hits - a.hits),
    };
  }

  return { daily, windows };
}

const clean = await collect(BOTS + NO_PT);
const withPt = await collect(BOTS);

const data = {
  generated_at: new Date().toISOString(),
  data_through: clean.daily[clean.daily.length - 1].day,
  ranges: WINDOWS.map((w) => w.key),
  views: { clean, with_pt: withPt },
};

if (PRINT_SQL) process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'public', 'data');
mkdirSync(dataDir, { recursive: true });

const lisbonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
const payload = JSON.stringify(data, null, 2) + '\n';
writeFileSync(join(dataDir, 'latest.json'), payload);
writeFileSync(join(dataDir, `${lisbonDate}.json`), payload);
console.log(
  `Snapshot written: data through ${data.data_through}, ` +
  `${clean.windows.d7.totals.visitors} visitors last 7 days ` +
  `(${withPt.windows.d7.totals.visitors} incl. Portugal)`
);
