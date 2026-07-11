import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate history + state writes to a throwaway dir
const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-daemon-test-'));
process.env.XDG_STATE_HOME = path.join(tmp, 'state');

const { Runner } = await import('../src/runner.js');

// A stub provider: auth_expired until a cookie is configured, then returns usage.
function stubProvider() {
  let cookie = null;
  return {
    name: 'stub',
    configure(cfg = {}) {
      if (cfg.cookie) cookie = cfg.cookie;
    },
    intervalSeconds() {
      return 999;
    },
    async poll() {
      if (!cookie) {
        const e = new Error('no cookie');
        e.code = 'auth_expired';
        throw e;
      }
      return {
        tier: 'free',
        windows: [
          { id: 'session', label: 'Session', pct: 5, resets_at: null, color: '#E69F00', will_deplete: false },
        ],
        segments: [],
      };
    },
  };
}

test('setCookie: persists to cookieFile (0600), reconfigures plugin, re-polls', async () => {
  const cookieFile = path.join(tmp, 'stub.cookie');
  const runner = new Runner();
  runner.add(stubProvider(), { cookieFile });

  // before a cookie: poll fails soft to auth_expired, stays alive
  const before = await runner.poll('stub');
  assert.equal(before.status, 'auth_expired');
  assert.equal(before.stale, true);

  // supply the cookie via the daemon (as the HTTP endpoint would)
  const snap = await runner.setCookie('stub', '  session=abc123  ');

  assert.equal(snap.status, 'ok');
  assert.equal(snap.stale, false);
  assert.equal(snap.windows[0].pct, 5);

  // cookie was written, trimmed, owner-only perms
  const written = readFileSync(cookieFile, 'utf8');
  assert.equal(written, 'session=abc123\n');
  const mode = statSync(cookieFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('setCookie: empty cookie rejected', async () => {
  const runner = new Runner();
  runner.add(stubProvider(), { cookieFile: path.join(tmp, 'x.cookie') });
  await assert.rejects(() => runner.setCookie('stub', '   '), /empty cookie/);
});
