// OpenCode Go usage provider plugin — descriptor interface.
//
// Go subscription meters 3 rolling windows (5h / weekly / monthly), each
// server-computed as {status, resetInSec, usagePercent}. Source is the
// cookie-authed workspace "Go" page — a stable URL (no build-hash header, no
// seroval RPC body, unlike the console's `_server` endpoint). Same shape as
// ollama.js: cookie GET HTML -> scrape hydration -> windows.
//
// parse() is a PURE function of the page HTML so it unit-tests against a
// vendored fixture with no network. fetch() adds cookie/workspace handling
// and auth-expiry detection around it.

export const ROLLING_COLOR = '#009E73'; // Okabe-Ito green (5h)
export const WEEKLY_COLOR = '#56B4E9';  // Okabe-Ito blue
export const MONTHLY_COLOR = '#E69F00'; // Okabe-Ito orange

export const ID = 'opencode-go';
export const LABEL = 'OpenCode Go';

export class AuthExpiredError extends Error {
  constructor(msg = 'opencode.ai session expired') {
    super(msg);
    this.code = 'auth_expired';
  }
}

export class RateLimitedError extends Error {
  constructor(retryAfter = null) {
    super('rate_limited');
    this.code = 'rate_limited';
    this.retryAfter = retryAfter;
  }
}

// Pull a `<key>:{...}` object literal out of the hydration script and read
// its fields by name (order in the source is not guaranteed). Real pages
// insert a Solid resumability reference between the key and the object
// literal — `rollingUsage:$R[33]={status:"ok",...}`, not `rollingUsage:{...}`
// — a hand-authored test fixture missed this and passed while the real page
// never matched (confirmed live 2026-07-18: raw capture had `$R[33]=` etc,
// parse() silently fell through to AuthExpiredError on a perfectly valid,
// 200-status page). The optional group tolerates that token generically
// (any `$R[<digits>]=`) without hardcoding a specific index.
function extractWindow(html, key) {
  const blockM = html.match(new RegExp(`${key}\\s*:\\s*(?:\\$R\\[\\d+\\]=)?\\{([^}]*)\\}`));
  if (!blockM) return null;
  const body = blockM[1];
  const statusM = body.match(/status\s*:\s*"([^"]+)"/);
  const resetM = body.match(/resetInSec\s*:\s*(\d+)/);
  const pctM = body.match(/usagePercent\s*:\s*(\d+(?:\.\d+)?)/);
  return {
    status: statusM ? statusM[1] : null,
    resetInSec: resetM ? Number(resetM[1]) : null,
    usagePercent: pctM ? Number(pctM[1]) : null,
  };
}

// Narrow but whitespace-tolerant scrape of the Go page hydration payload.
export function parse(html) {
  if (!/rollingUsage/.test(html)) throw new AuthExpiredError();

  const rolling = extractWindow(html, 'rollingUsage');
  const weekly = extractWindow(html, 'weeklyUsage');
  const monthly = extractWindow(html, 'monthlyUsage');
  if (!rolling) throw new AuthExpiredError();

  const tierM = html.match(/"plan"\s*:\s*"([^"]+)"/) ?? html.match(/tier\s*:\s*"([^"]+)"/);
  const tier = tierM ? tierM[1].toLowerCase() : 'lite';

  const resetsAt = (w) =>
    w && Number.isFinite(w.resetInSec)
      ? new Date(Date.now() + w.resetInSec * 1000).toISOString()
      : null;

  const pctOf = (w) => (w && w.status === 'ok' ? w.usagePercent : null);

  const windows = [
    {
      id: '5h',
      label: '5 Hour',
      letter: '5h',
      pct: pctOf(rolling),
      resets_at: resetsAt(rolling),
      color: ROLLING_COLOR,
      will_deplete: false,
    },
    {
      id: 'weekly',
      label: 'Weekly',
      letter: 'Wk',
      pct: pctOf(weekly),
      resets_at: resetsAt(weekly),
      color: WEEKLY_COLOR,
      will_deplete: false,
    },
    {
      id: 'monthly',
      label: 'Monthly',
      letter: 'Mo',
      pct: pctOf(monthly),
      resets_at: resetsAt(monthly),
      color: MONTHLY_COLOR,
      will_deplete: false,
    },
  ];

  return { tier, windows, segments: [] };
}

const BASE_URL = 'https://opencode.ai';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';

function createProvider() {
  let cookie = null;
  let workspaceId = null;

  async function discoverWorkspaceId() {
    const res = await fetch(`${BASE_URL}/workspace`, {
      headers: {
        Cookie: cookie,
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
    if (res.status === 429) {
      throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
    }
    if (!res.ok) throw new Error(`opencode.ai HTTP ${res.status}`);
    const html = await res.text();
    const idM = html.match(/\bwrk_[A-Za-z0-9]+\b/);
    if (!idM) throw new AuthExpiredError('could not discover opencode workspace id');
    return idM[0];
  }

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'cookie' },

    config() {
      return {
        id: ID,
        label: LABEL,
        auth: { kind: 'cookie' },
        windows: [
          { id: '5h', label: '5 Hour', color: ROLLING_COLOR },
          { id: 'weekly', label: 'Weekly', color: WEEKLY_COLOR },
          { id: 'monthly', label: 'Monthly', color: MONTHLY_COLOR },
        ],
        tiers: ['lite'],
      };
    },

    configure(cfg = {}) {
      // !== undefined (not truthy) so configure({cookie:''}) can explicitly
      // clear it — a flush action, not just "no change was requested".
      if (cfg.cookie !== undefined) cookie = cfg.cookie;
      // Accept either the bare id or a full workspace URL and pull the id
      // out of it — matches CodexBar's CODEXBAR_OPENCODE_WORKSPACE_ID
      // convention, one less thing for whoever configures this to get wrong
      // copy-pasting straight from the browser's address bar.
      if (cfg.workspace_id) {
        const m = String(cfg.workspace_id).match(/wrk_[A-Za-z0-9]+/);
        if (m) workspaceId = m[0];
      }
    },

    async fetch() {
      if (!cookie) throw new AuthExpiredError('no opencode-go cookie configured');
      if (!workspaceId) workspaceId = await discoverWorkspaceId();

      const res = await fetch(`${BASE_URL}/workspace/${workspaceId}/go`, {
        headers: {
          Cookie: cookie,
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
        },
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) throw new AuthExpiredError();
      if (res.status === 429) {
        throw new RateLimitedError(Number(res.headers.get('retry-after')) || null);
      }
      if (!res.ok) throw new Error(`opencode.ai HTTP ${res.status}`);
      return res.text();
    },

    intervalSeconds() {
      return 300;
    },

    meta() {
      return {};
    },

    parse,
  };
}

export { createProvider };
