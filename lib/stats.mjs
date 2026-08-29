// Builds the whole stats payload from PostHog. Shared by two callers:
// api/stats.mjs (queried live on page load) and scripts/fetch-stats.mjs
// (the daily archive, which doubles as the page's fallback).
//
// Every figure is computed for each date range in WINDOWS, twice: once with
// Portugal excluded (the default view) and once with it counted in. The page
// only switches between prepared numbers, it never aggregates.
//
// Both variants come back from the SAME query rather than a second pass. Cost
// here is dominated by per-request overhead on PostHog's query API, not by
// scanning, so the count of round trips is what page-load latency tracks.

const PROJECT_ID = 235837;
const API_HOST = 'https://eu.posthog.com';

// The standard traffic filter, always applied: no flagged bots, no datacenter
// cities, no 1920x1080-exact viewports (headless Chrome fingerprint).
const BOTS = `
  AND NOT coalesce(properties.$virt_is_bot, false)
  AND coalesce(properties.$geoip_city_name, '') NOT IN ('Boydton', 'Dulles', 'Paris', 'Amsterdam')
  AND NOT (coalesce(properties.$viewport_width, 0) = 1920 AND coalesce(properties.$viewport_height, 0) = 1080)`;

// Portugal is his own traffic. Rather than filter it in the WHERE clause, it
// rides inside each aggregate's condition, so one scan yields both views.
const VARIANTS = [
  { key: 'clean', cond: `coalesce(properties.$geoip_country_code, '') != 'PT'` },
  { key: 'all', cond: '1' },
];

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
// All of history. A fixed floor keeps the scan bounded; this project's first
// event is 2026-07-29, so the date below is a safe bound, not a start date.
const ALL_TIME = `timestamp >= toDate('2020-01-01') AND timestamp <= now()`;

const CUSTOM_EVENTS = ['project_open', 'outbound_click', 'section_view', 'scroll_depth'];

// The six project pages. The funnel and trajectories are computed from
// pageviews on these paths, NOT from the project_open click event: capture()
// races the same-tab navigation and loses, so project_open only records
// new-tab opens (verified 2026-08-29: 62 home→project pageview transitions in
// 30 days, 9 project_open events, all of them Portugal).
const PROJECT_RE = '^/(confirmo|mara|starcount|penfold|cable|done)';

// Emit one expression per (variant, window) pair, e.g. p_clean_d7 / p_all_d7.
const perVW = (fn) => VARIANTS.flatMap((v) => WINDOWS.map((w) => fn(v, w))).join(',\n    ');
const perV = (fn) => VARIANTS.map(fn).join(',\n    ');

// Counts for one grouped row, per variant and window.
const listCols = () =>
  perVW((v, w) =>
    `countIf(${inW(w.days)} AND ${v.cond}) AS p_${v.key}_${w.key}, ` +
    `uniqIf(person_id, ${inW(w.days)} AND ${v.cond}) AS v_${v.key}_${w.key}`);

// A grouped list (pages / sources / countries) sliced per window for one variant.
function sliceList(rows, nameKey, sortBy, vk) {
  const out = {};
  for (const w of WINDOWS) {
    out[w.key] = rows
      .map((r) => ({ [nameKey]: r[nameKey], pageviews: r[`p_${vk}_${w.key}`], visitors: r[`v_${vk}_${w.key}`] }))
      .filter((r) => r.pageviews > 0)
      // Name last, so ties don't reshuffle between loads.
      .sort((a, b) =>
        b[sortBy] - a[sortBy] ||
        b.pageviews - a.pageviews ||
        String(a[nameKey]).localeCompare(String(b[nameKey])))
      .slice(0, 12);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]    PostHog personal API key, query:read scope.
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

  const [totalsRows, dailyRows, pagesRows, sourcesRows, countriesRows, eventsRows, funnelRows, sessionRows] = await gather([
    () => hogql(`
    SELECT
    ${perVW((v, w) =>
      `uniqIf(person_id, ${inW(w.days)} AND ${v.cond}) AS v_${v.key}_${w.key},
    countIf(${inW(w.days)} AND ${v.cond}) AS p_${v.key}_${w.key},
    uniqIf(person_id, ${inPrev(w.days)} AND ${v.cond}) AS pv_${v.key}_${w.key},
    countIf(${inPrev(w.days)} AND ${v.cond}) AS pp_${v.key}_${w.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${since(2 * LONGEST - 1)} ${BOTS}`),

    () => hogql(`
    SELECT toDate(timestamp) AS day,
    ${perV((v) => `countIf(${v.cond}) AS p_${v.key}, uniqIf(person_id, ${v.cond}) AS v_${v.key}`)}
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${BOTS}
    GROUP BY day ORDER BY day`),

    // Scanned over all of history, so the same rows give both the per-range
    // numbers and the all-time totals for the pages table.
    () => hogql(`
    SELECT coalesce(properties.$pathname, '?') AS path,
    ${perV((v) => `countIf(${v.cond}) AS all_p_${v.key}, uniqIf(person_id, ${v.cond}) AS all_v_${v.key}`)},
    ${listCols()}
    FROM events
    WHERE event = '$pageview' AND ${ALL_TIME} ${BOTS}
    GROUP BY path LIMIT 200`),

    () => hogql(`
    SELECT coalesce(nullIf(properties.$referring_domain, ''), '$direct') AS source,
    ${listCols()}
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)}
      AND coalesce(properties.$referring_domain, '') != coalesce(properties.$host, '') ${BOTS}
    GROUP BY source LIMIT 200`),

    () => hogql(`
    SELECT coalesce(nullIf(properties.$geoip_country_name, ''), 'Unknown') AS country,
    ${listCols()}
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${BOTS}
    GROUP BY country LIMIT 200`),

    () => hogql(`
    SELECT event,
    ${perVW((v, w) =>
      `countIf(${inW(w.days)} AND ${v.cond}) AS h_${v.key}_${w.key}, ` +
      `uniqIf(person_id, ${inW(w.days)} AND ${v.cond}) AS v_${v.key}_${w.key}`)}
    FROM events
    WHERE event IN (${CUSTOM_EVENTS.map((e) => `'${e}'`).join(', ')}) AND ${since(LONGEST - 1)} ${BOTS}
    GROUP BY event`),

    // The home funnel: of the visitors whose first pageview in the window was
    // the home page, how many went on to open at least one project page, and
    // which project each converting visitor reached FIRST. Because entry is
    // their first pageview, any project view in the window is after it.
    // Per-person firsts need a subquery, so this is its own request; the
    // outer SELECT collapses it to one row. The first-open lists stay
    // per-visitor (traffic is tiny) and are tallied in shape(), so the mode
    // is exact.
    () => hogql(`
    SELECT
    ${perVW((v, w) =>
      `countIf(entry_${v.key}_${w.key} = '/') AS landed_${v.key}_${w.key},
    countIf(entry_${v.key}_${w.key} = '/' AND fp_${v.key}_${w.key} != '') AS opened_${v.key}_${w.key},
    groupArrayIf(fp_${v.key}_${w.key}, entry_${v.key}_${w.key} = '/' AND fp_${v.key}_${w.key} != '') AS fps_${v.key}_${w.key}`)}
    FROM (
      SELECT person_id,
      ${perVW((v, w) =>
        `argMinIf(coalesce(properties.$pathname, ''), timestamp, ${inW(w.days)} AND ${v.cond}) AS entry_${v.key}_${w.key},
      argMinIf(coalesce(properties.$pathname, ''), timestamp, match(coalesce(properties.$pathname, ''), '${PROJECT_RE}') AND ${inW(w.days)} AND ${v.cond}) AS fp_${v.key}_${w.key}`)}
      FROM events
      WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${BOTS}
      GROUP BY person_id
    )`),

    // One row per visit: the session's ordered pages plus when it started and
    // whether it is Portugal, so shape() can slice it into every window and
    // both variants without further round trips.
    () => hogql(`
    SELECT
    coalesce(properties.$session_id, concat('p-', toString(person_id))) AS sid,
    toUnixTimestamp(min(timestamp)) AS started,
    max(coalesce(properties.$geoip_country_code, '') = 'PT') AS pt,
    arrayMap(t -> t.2, arraySort(groupArray((toUnixTimestamp(timestamp), coalesce(properties.$pathname, '?'))))) AS pages
    FROM events
    WHERE event = '$pageview' AND ${since(LONGEST - 1)} ${BOTS}
    GROUP BY sid`),
  ]);

  const tot = totalsRows[0] ?? {};
  const fun = funnelRows[0] ?? {};

  // Today's UTC midnight, the anchor every window hangs off.
  const dayStartMs = new Date().setUTCHours(0, 0, 0, 0);

  // One visit = one session: start time, Portugal flag, and its page sequence
  // with reloads (consecutive repeats) collapsed.
  const visits = sessionRows.map((s) => ({
    startMs: s.started * 1000,
    pt: !!s.pt,
    pages: s.pages.filter((p, i) => p !== s.pages[i - 1]),
  }));

  // One view — Portugal out, or Portugal in — read off the shared result rows.
  function shape(vk) {
    // Dense-fill the daily series: every one of the 30 days, zeros included.
    const byDay = new Map(dailyRows.map((r) => [r.day, r]));
    const daily = [];
    const end = new Date(); // walk backward from today (UTC), 30 days, today last
    end.setUTCHours(0, 0, 0, 0);
    for (let i = LONGEST - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      daily.push({ day: key, visitors: row?.[`v_${vk}`] ?? 0, pageviews: row?.[`p_${vk}`] ?? 0 });
    }

    const pages = sliceList(pagesRows, 'path', 'pageviews', vk);
    const sources = sliceList(sourcesRows, 'source', 'visitors', vk);
    const countries = sliceList(countriesRows, 'country', 'visitors', vk);

    // Every path ever seen, all-time totals first, each range hung off it.
    const pagesTable = pagesRows
      .map((r) => ({
        path: r.path,
        all_pageviews: r[`all_p_${vk}`],
        all_visitors: r[`all_v_${vk}`],
        w: Object.fromEntries(
          WINDOWS.map((w) => [w.key, { pageviews: r[`p_${vk}_${w.key}`], visitors: r[`v_${vk}_${w.key}`] }])
        ),
      }))
      .filter((r) => r.all_pageviews > 0)
      .sort((a, b) =>
        b.all_pageviews - a.all_pageviews ||
        b.all_visitors - a.all_visitors ||
        a.path.localeCompare(b.path));

    const windows = {};
    for (const w of WINDOWS) {
      // First project reached per converting visitor, '/mara' -> 'mara'.
      const fpTally = new Map();
      for (const p of fun[`fps_${vk}_${w.key}`] ?? []) {
        const slug = p.slice(1).split('/')[0];
        fpTally.set(slug, (fpTally.get(slug) ?? 0) + 1);
      }

      // Every visit that started inside the window, identical page sequences
      // collapsed into one row with a count.
      const trajTally = new Map();
      const wStartMs = dayStartMs - (w.days - 1) * 86400000;
      for (const s of visits) {
        if (s.startMs < wStartMs || (vk !== 'all' && s.pt)) continue;
        const key = JSON.stringify(s.pages);
        const t = trajTally.get(key) ?? { pages: s.pages, visits: 0 };
        t.visits += 1;
        trajTally.set(key, t);
      }

      windows[w.key] = {
        home_funnel: {
          landed: fun[`landed_${vk}_${w.key}`] ?? 0,
          opened: fun[`opened_${vk}_${w.key}`] ?? 0,
          first_opens: [...fpTally]
            .map(([project, visitors]) => ({ project, visitors }))
            .sort((a, b) => b.visitors - a.visitors || a.project.localeCompare(b.project)),
        },
        trajectories: [...trajTally.values()]
          .sort((a, b) =>
            b.visits - a.visits ||
            b.pages.length - a.pages.length ||
            a.pages.join('\n').localeCompare(b.pages.join('\n'))),
        totals: {
          visitors: tot[`v_${vk}_${w.key}`],
          pageviews: tot[`p_${vk}_${w.key}`],
          prev_visitors: tot[`pv_${vk}_${w.key}`],
          prev_pageviews: tot[`pp_${vk}_${w.key}`],
        },
        top_pages: pages[w.key],
        sources: sources[w.key],
        countries: countries[w.key],
        events: CUSTOM_EVENTS.map((name) => {
          const row = eventsRows.find((r) => r.event === name);
          return {
            event: name,
            hits: row?.[`h_${vk}_${w.key}`] ?? 0,
            visitors: row?.[`v_${vk}_${w.key}`] ?? 0,
          };
        }).sort((a, b) => b.hits - a.hits),
      };
    }

    return { daily, windows, pages_table: pagesTable };
  }

  const clean = shape('clean');

  return {
    generated_at: new Date().toISOString(),
    data_through: clean.daily[clean.daily.length - 1].day,
    ranges: WINDOWS.map((w) => w.key),
    views: { clean, with_pt: shape('all') },
  };
}
