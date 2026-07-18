import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parse,
  AuthExpiredError,
  ROLLING_COLOR,
  WEEKLY_COLOR,
  MONTHLY_COLOR,
} from '../src/providers/opencode-go.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const goHtml = readFileSync(path.resolve(here, 'fixtures/opencode-go-go.html'), 'utf8');

test('parse: 3 windows from rollingUsage/weeklyUsage/monthlyUsage hydration', () => {
  const { tier, windows, segments } = parse(goHtml);
  assert.equal(tier, 'lite');
  assert.equal(windows.length, 3);
  assert.deepEqual(segments, []);

  const rolling = windows.find((w) => w.id === '5h');
  const weekly = windows.find((w) => w.id === 'weekly');
  const monthly = windows.find((w) => w.id === 'monthly');

  assert.equal(rolling.pct, 6);
  assert.equal(rolling.letter, '5h');
  assert.equal(rolling.color, ROLLING_COLOR);
  assert.equal(rolling.will_deplete, false);

  assert.equal(weekly.pct, 2);
  assert.equal(weekly.letter, 'Wk');
  assert.equal(weekly.color, WEEKLY_COLOR);

  assert.equal(monthly.pct, 1);
  assert.equal(monthly.letter, 'Mo');
  assert.equal(monthly.color, MONTHLY_COLOR);
});

test('parse: resets_at derived from resetInSec relative to now', () => {
  const before = Date.now();
  const { windows } = parse(goHtml);
  const after = Date.now();
  const rolling = windows.find((w) => w.id === '5h');
  const resetMs = new Date(rolling.resets_at).getTime();
  // resetInSec:5507 in the fixture
  assert.ok(resetMs >= before + 5507 * 1000);
  assert.ok(resetMs <= after + 5507 * 1000);
});

test('parse: status!=="ok" window yields null pct', () => {
  const html = goHtml.replace(
    'rollingUsage: { status: "ok", resetInSec: 5507, usagePercent: 6 }',
    'rollingUsage: { status: "error", resetInSec: 5507, usagePercent: 6 }',
  );
  const { windows } = parse(html);
  assert.equal(windows.find((w) => w.id === '5h').pct, null);
});

test('parse: missing rollingUsage block throws auth_expired', () => {
  assert.throws(() => parse('<html><body>logged out</body></html>'), AuthExpiredError);
});

test('parse: field order in the object literal does not matter', () => {
  const html = `
    <script>
      $R.push(["lite.subscription.get", ["wrk_x"], {
        rollingUsage: { usagePercent: 42, status: "ok", resetInSec: 100 },
        weeklyUsage: { status: "ok", resetInSec: 200, usagePercent: 10 },
        monthlyUsage: { resetInSec: 300, usagePercent: 5, status: "ok" },
      }]);
    </script>
  `;
  const { windows } = parse(html);
  assert.equal(windows.find((w) => w.id === '5h').pct, 42);
  assert.equal(windows.find((w) => w.id === 'weekly').pct, 10);
  assert.equal(windows.find((w) => w.id === 'monthly').pct, 5);
});
