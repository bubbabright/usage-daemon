import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, AuthExpiredError } from '../src/providers/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// PII-scrubbed sample shaped like GET https://api.anthropic.com/api/oauth/usage.
const FIXTURE = path.resolve(here, 'fixtures/claude-usage.json');
const raw = readFileSync(FIXTURE, 'utf8');

test('parse: session (5h) + weekly (7d) windows with correct pct/resets/letter', () => {
  const { windows } = parse(raw);
  const session = windows.find((w) => w.id === 'session');
  const weekly = windows.find((w) => w.id === 'weekly');

  assert.equal(session.pct, 12);
  assert.equal(session.resets_at, '2026-07-13T18:00:00Z');
  assert.equal(session.letter, '5h');
  assert.equal(session.color, '#E69F00');

  assert.equal(weekly.pct, 34);
  assert.equal(weekly.resets_at, '2026-07-18T00:00:00Z');
  assert.equal(weekly.letter, 'Wk');
  assert.equal(weekly.color, '#56B4E9');
});

test('parse: tier is null (claude has no tier concept)', () => {
  const { tier } = parse(raw);
  assert.equal(tier, null);
});

test('parse: no segments (claude has no per-model segment breakdown)', () => {
  const { segments } = parse(raw);
  assert.deepEqual(segments, []);
});

test('parse: missing five_hour/seven_day throws auth_expired', () => {
  assert.throws(() => parse('{"unrelated": true}'), AuthExpiredError);
});

test('parse: unparseable body throws auth_expired', () => {
  assert.throws(() => parse('not json'), AuthExpiredError);
});
