import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parse,
  extractSpendTotal,
  nextMonthStartUtc,
  AuthExpiredError,
  VIBE_COLOR,
  SPEND_COLOR,
} from '../src/providers/mistral.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vibeRaw = readFileSync(path.resolve(here, 'fixtures/mistral-vibe.json'), 'utf8');
const usageRaw = readFileSync(path.resolve(here, 'fixtures/mistral-usage.json'), 'utf8');
const limitRaw = readFileSync(
  path.resolve(here, 'fixtures/mistral-spend-limit.json'),
  'utf8',
);

function envelope({ vibe = null, usage = null, spend_limit = null } = {}) {
  return JSON.stringify({ vibe, usage, spend_limit });
}

test('parse vibe: remaining→used inversion, reset_at pass-through', () => {
  const { windows, tier } = parse(envelope({ vibe: vibeRaw }));
  const w = windows.find((x) => x.id === 'vibe_monthly');
  assert.ok(w);
  // usage_percentage 100 = remaining full → pct used 0
  assert.equal(w.pct, 0);
  assert.equal(w.resets_at, '2026-08-01T00:00:00Z');
  assert.equal(w.letter, 'Vb');
  assert.equal(w.label, 'Vibe');
  assert.equal(w.color, VIBE_COLOR);
  assert.equal(w.will_deplete, false);
  assert.equal(tier, 'free');
  assert.equal(windows.length, 1);
});

test('parse vibe: partial remaining inverts correctly', () => {
  const partial = JSON.stringify({
    result: {
      data: {
        json: {
          usage_percentage: 73.5,
          payg_enabled: false,
          reset_at: '2026-09-01T00:00:00Z',
        },
      },
    },
  });
  const { windows } = parse(envelope({ vibe: partial }));
  assert.equal(windows[0].pct, 26.5);
  assert.equal(windows[0].resets_at, '2026-09-01T00:00:00Z');
});

test('parse dual envelope: vibe + spend → two windows', () => {
  const { windows } = parse(
    envelope({ vibe: vibeRaw, usage: usageRaw, spend_limit: limitRaw }),
  );
  assert.equal(windows.length, 2);
  const vibe = windows.find((w) => w.id === 'vibe_monthly');
  const spend = windows.find((w) => w.id === 'monthly_spend');
  assert.equal(vibe.pct, 0);
  assert.equal(spend.pct, 0); // $0 / $10
  assert.equal(spend.letter, '$');
  assert.equal(spend.color, SPEND_COLOR);
  // month=7 year=2026 → 1 Aug UTC
  assert.equal(spend.resets_at, '2026-08-01T00:00:00Z');
});

test('parse vibe-only: one window, no throw when admin legs null', () => {
  const { windows } = parse(envelope({ vibe: vibeRaw }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'vibe_monthly');
});

test('parse spend with no_monthly_limit: pct null, window still present', () => {
  const unlimited = JSON.stringify({ amount: 0, no_monthly_limit: true });
  const usage = JSON.stringify({ total: 3.5, month: 7, year: 2026 });
  // spend-only path (no vibe)
  const { windows } = parse(
    envelope({ vibe: null, usage, spend_limit: unlimited }),
  );
  const spend = windows.find((w) => w.id === 'monthly_spend');
  assert.ok(spend);
  assert.equal(spend.pct, null);
  assert.equal(spend.resets_at, '2026-08-01T00:00:00Z');
});

test('parse spend: non-zero spend / cap pct', () => {
  const usage = JSON.stringify({ total: 2.5 });
  const limit = JSON.stringify({ amount: 10, no_monthly_limit: false });
  const { windows } = parse(
    envelope({ vibe: null, usage, spend_limit: limit }),
  );
  assert.equal(windows.find((w) => w.id === 'monthly_spend').pct, 25);
});

test('parse: garbage vibe alone throws auth_expired', () => {
  assert.throws(
    () => parse(envelope({ vibe: '{"unrelated":true}' })),
    AuthExpiredError,
  );
  assert.throws(() => parse(envelope({ vibe: 'not json' })), AuthExpiredError);
  assert.throws(() => parse(envelope({})), AuthExpiredError);
  assert.throws(() => parse('not json'), AuthExpiredError);
});

test('parse: spend alone without vibe still ok', () => {
  const { windows } = parse(
    envelope({
      vibe: null,
      usage: usageRaw,
      spend_limit: limitRaw,
    }),
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'monthly_spend');
});

test('extractSpendTotal: total field and category sum', () => {
  assert.equal(extractSpendTotal({ total: 4.2 }), 4.2);
  assert.equal(
    extractSpendTotal({ completion: 1, ocr: 2, audio: 0.5 }),
    3.5,
  );
  assert.equal(extractSpendTotal({}), null);
});

test('nextMonthStartUtc: first of following month', () => {
  const d = new Date(Date.UTC(2026, 6, 15)); // Jul 15 2026
  assert.equal(nextMonthStartUtc(d), '2026-08-01T00:00:00Z');
});
