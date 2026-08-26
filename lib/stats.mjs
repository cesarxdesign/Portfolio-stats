// Builds the whole stats payload from PostHog. Shared by two callers:
// api/stats.mjs (queried live on page load) and scripts/fetch-stats.mjs
// (the daily archive, which doubles as the page's fallback).
//
// Every figure is computed for each date range in WINDOWS, twice: once with
// Portugal excluded (the default view) and once with it counted in. The page
// only switches between prepared numbers, it never aggregates.

const PROJECT_ID = 235837;
const API_HOST = 'https://eu.posthog.com';

// The standard traffic filter, always applied: no flagged bots, no datacenter
// cities, no 1920x1080-exact viewports (headless Chrome fingerprint).
const BOTS = `
  AND NOT coalesce(properties.$virt_is_bot, false)
  AND coalesce(properties.$geoip_city_name, '') NOT IN ('Boydton', 'Dulles', 'Paris', 'Amsterdam')
  AND NOT (coalesce(properties.$viewport_width, 0) = 1920 AND coalesce(properties.$viewport_height, 0) = 1080)`;

// Portugal is his own traffic: out by default, toggleable back in on the page.
const NO_PT = `
  AND coalesce(properties.$geoip_country_code, '') != 'PT'`;

// Selectable date ranges. d30 is "Last month".
const WINDOWS = [1, 2, 3, 4, 5, 6, 7, 30].map((days) => ({ key: `d${days}`, days }));
const LONGEST = 30;

// A range of N calendar days ending right now: today so far, plus the N-1
// complete days before it. The deltas compare against the N complete days
// immediately preceding that.
const inW = (n) => `timestamp >= toStartOfDay(now()) - INTERVAL ${n - 1} DAY AND timestamp <= now()`;
const inPrev = (n) =>
  `timestamp >= toStartOfDay(now()) - INTERVAL ${2 * n - 1} DAY AND timestamp < toStartOfDay(now()) - INTERVAL ${n - 1} DAY`;
// Outer scan bound for a query: far enough back to cover every window it uses.
const since = (n) => `timestamp >= toStartOfDay(now()) - INTERVAL ${n} DAY AND timestamp <= now()`;

const CUSTOM_EVENTS = ['project_open', 'outbound_click', 'section_view', 'scroll_depth'];

const perWindow = (fn) => WINDOWS.map(fn).join(',\n    ');

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

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]   PostHog personal API key, query:read scope.
 * @param {boolean} [opts.printSql] Dump the generated HogQL and run nothing.
 */
export async function collectAll({ apiKey, printSql = false } = {}) {
  let printed = 0;

  async function hogql(query) {
    if (printSql) {
      console.log(`\n-- ${++printed} --${query}`);
      return [];
    }
    const res = await fetch(`${API_HOST}/api/projects/${PROJECT_ID}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

  // Under printSql the queries run one at a time, so the dump stays in order.
  const gather = (thunks) =>
    printSql
      ? thunks.reduce(async (prev, t) => [...(await prev), await t()], Promise.resolve([]))
      : Promise.all(thunks.map((t) => t()));

  // "All time" needs a floor to stay off an unbounded scan, so take the
  // project's first event and use its day. Under printSql there is no result
  // to read, so fall back to a date safely before this project existed.
  const firstEvent = (await hogql(`SELECT min(timestamp) AS t FROM events`))[0]?.t;
  const ALL_TIME = `timestamp >= toDate('${String(firstEvent ?? '2020-01-01').slice(0, 10)}') AND timestamp <= now()`;

  // One complete set of figures under a given traffic filter.
  async function collect(FILTER) {
    const [totalsRows, dailyRows, pagesRows, sourcesRows, countriesRows, eventsRows] = await gather([
      () => hogql(`
    SELECT
    ${perWindow((w) =>
      `uniqIf(person_id, ${inW(w.days)}) AS v_${w.key},
    countIf(${inW(w.days)}) AS p_${w.key},
    uniqIf(person_id, ${inPrev(w.days)}) AS pv_${w.key},
    countIf(${inPrev(w.days)}) AS pp_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${since(2 * LONGEST - 1)} ${FILTER}`),

      () => hogql(`
    SELECT toDate(timestamp) AS day, uniq(person_id) AS visitors, count() AS pageviews
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${FILTER}
    GROUP BY day ORDER BY day`),

      // Scanned over all of history, so the same rows give both the per-range
      // numbers and the all-time totals for the pages table.
      () => hogql(`
    SELECT coalesce(properties.$pathname, '?') AS path,
    count() AS all_p, uniq(person_id) AS all_v,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${ALL_TIME} ${FILTER}
    GROUP BY path LIMIT 200`),

      () => hogql(`
    SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)}
      AND coalesce(properties.$referring_domain, '') != coalesce(properties.$host, '') ${FILTER}
    GROUP BY source LIMIT 200`),

      () => hogql(`
    SELECT coalesce(nullIf(properties.$geoip_country_name, ''), 'Unknown') AS country,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS p_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${FILTER}
    GROUP BY country LIMIT 200`),

      () => hogql(`
    SELECT event,
    ${perWindow((w) => `countIf(${inW(w.days)}) AS h_${w.key}, uniqIf(person_id, ${inW(w.days)}) AS v_${w.key}`)}
    FROM events
    WHERE event IN (${CUSTOM_EVENTS.map((e) => `'${e}'`).join(', ')}) AND ${since(LONGEST - 1)} ${FILTER}
    GROUP BY event`),
    ]);

    const tot = totalsRows[0] ?? {};

    // Dense-fill the daily series: every one of the 30 days, zeros included.
    const byDay = new Map(dailyRows.map((r) => [r.day, r]));
    const daily = [];
    const end = new Date(); // walk backward from today (UTC), 30 days, today last
    end.setUTCHours(0, 0, 0, 0);
    for (let i = LONGEST - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      daily.push({ day: key, visitors: row?.visitors ?? 0, pageviews: row?.pageviews ?? 0 });
    }

    const pages = sliceList(pagesRows, 'path', 'pageviews');

    // Every path ever seen, all-time totals first, each range hung off it.
    const pagesTable = pagesRows
      .map((r) => ({
        path: r.path,
        all_pageviews: r.all_p,
        all_visitors: r.all_v,
        w: Object.fromEntries(WINDOWS.map((w) => [w.key, { pageviews: r[`p_${w.key}`], visitors: r[`v_${w.key}`] }])),
      }))
      .sort((a, b) => b.all_pageviews - a.all_pageviews || b.all_visitors - a.all_visitors);
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

    return { daily, windows, pages_table: pagesTable };
  }

  const clean = await collect(BOTS + NO_PT);
  const withPt = await collect(BOTS);

  return {
    generated_at: new Date().toISOString(),
    data_through: clean.daily[clean.daily.length - 1].day,
    ranges: WINDOWS.map((w) => w.key),
    views: { clean, with_pt: withPt },
  };
}
