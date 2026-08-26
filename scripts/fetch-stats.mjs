// Writes public/data/latest.json plus a dated snapshot. Runs daily in GitHub
// Actions (~4am Europe/Lisbon) to keep the history archive, which also serves
// as the page's fallback when the live endpoint is unavailable.
//
// The page itself no longer reads these files first — it queries api/stats.mjs.
// Both share lib/stats.mjs, so the numbers are built by identical code.
//
// Requires: POSTHOG_API_KEY (personal API key, query:read scope).
// PRINT_SQL=1 dumps the generated HogQL and runs no queries, so the SQL can be
// checked against PostHog without a key in hand.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from '../lib/stats.mjs';

const apiKey = process.env.POSTHOG_API_KEY;
const printSql = process.env.PRINT_SQL === '1';
if (!apiKey && !printSql) {
  console.error('POSTHOG_API_KEY is not set');
  process.exit(1);
}

const data = await collectAll({ apiKey, printSql });
if (printSql) process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'public', 'data');
mkdirSync(dataDir, { recursive: true });

const lisbonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
const payload = JSON.stringify(data, null, 2) + '\n';
writeFileSync(join(dataDir, 'latest.json'), payload);
writeFileSync(join(dataDir, `${lisbonDate}.json`), payload);
console.log(
  `Snapshot written: data through ${data.data_through}, ` +
  `${data.views.clean.windows.d7.totals.visitors} visitors last 7 days ` +
  `(${data.views.with_pt.windows.d7.totals.visitors} incl. Portugal)`
);
