// Mistral usage provider plugin — descriptor interface (HANDOFF-20).
//
// Two meters, one poll:
//   - vibe_monthly (required path): free-tier Vibe entitlement via cookie tRPC
//     GET admin.mistral.ai/api/local-trpc/billing.vibeUsage
//     API returns usage_percentage = REMAINING → suite pct = 100 - remaining
//   - monthly_spend (optional): Admin-role API key
//     GET console.mistral.ai/api/admin/usage  ÷  /admin/spend-limit
//
// parse() is a PURE function of a combined envelope string
//   { vibe, usage, spend_limit }  // each field raw JSON text or null
// so it unit-tests against fixtures with no network/fs. fetch() assembles the
// envelope. Cookie write is only via POST /usage/mistral/cookie (runner).
// Never write Admin keys or Mistral credential files.

export const VIBE_COLOR = '#E69F00';  // Okabe-Ito orange
export const SPEND_COLOR = '#56B4E9'; // Okabe-Ito blue

export const ID = 'mistral';
export const LABEL = 'Mistral';

const VIBE_INPUT = JSON.stringify({
  json: null,
  meta: { values: ['undefined'], v: 1 },
});
const VIBE_URL =
  'https://admin.mistral.ai/api/local-trpc/billing.vibeUsage?input=' +
  encodeURIComponent(VIBE_INPUT);
const ADMIN_BASE = 'https://console.mistral.ai/api/admin';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) usage-daemon/0.1';

// Category keys documented / observed on the usage dashboard.
const SPEND_CATEGORY_KEYS = [
  'chat',
  'completion',
  'ocr',
  'audio',
  'connectors',
  'libraries_api',
  'libraries',
  'fine_tuning',
  'vibe_usage',
  'vibe',
];

export class AuthExpiredError extends Error {
  constructor(msg = 'Mistral session expired or missing credentials') {
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

// First of next calendar month, UTC (Vibe + spend both reset this way).
export function nextMonthStartUtc(from = new Date()) {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString().replace('.000', '');
}

// Pull nested tRPC result.data.json or return the object if already flat.
function vibePayload(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj?.result?.data?.json ?? obj?.data?.json ?? obj;
}

// Sum $ spend from Admin /usage body. Tolerant of total field or category map.
export function extractSpendTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;

  for (const k of ['total', 'total_cost', 'total_amount', 'amount', 'usage']) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v.amount === 'number') return v.amount;
    if (v && typeof v === 'object' && typeof v.total === 'number') return v.total;
  }

  let sum = 0;
  let found = false;
  for (const k of SPEND_CATEGORY_KEYS) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      found = true;
    } else if (v && typeof v === 'object') {
      const n = v.amount ?? v.cost ?? v.total ?? v.usd;
      if (typeof n === 'number' && Number.isFinite(n)) {
        sum += n;
        found = true;
      }
    }
  }
  if (found) return sum;

  // Nested { costs: { completion: 1.2, ... } } style
  const costs = usage.costs || usage.breakdown || usage.categories;
  if (costs && typeof costs === 'object') {
    let s = 0;
    let n = 0;
    for (const v of Object.values(costs)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        s += v;
        n++;
      } else if (v && typeof v === 'object') {
        const x = v.amount ?? v.cost ?? v.total;
        if (typeof x === 'number' && Number.isFinite(x)) {
          s += x;
          n++;
        }
      }
    }
    if (n) return s;
  }

  return null;
}

function periodEndFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  for (const k of [
    'end',
    'period_end',
    'billing_period_end',
    'periodEnd',
    'end_date',
  ]) {
    if (typeof usage[k] === 'string' && usage[k]) return usage[k];
  }
  // month/year → first of next month
  const month = usage.month ?? usage.Month;
  const year = usage.year ?? usage.Year;
  if (typeof month === 'number' && typeof year === 'number') {
    // API months are 1-based
    return new Date(Date.UTC(year, month, 1, 0, 0, 0))
      .toISOString()
      .replace('.000', '');
  }
  return null;
}

// Pure function of the envelope JSON text — no fs/network.
export function parse(raw) {
  let envelope;
  try {
    envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new AuthExpiredError('unparseable mistral envelope');
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new AuthExpiredError('unparseable mistral envelope');
  }

  const windows = [];
  let tier = null;
  let vibeOk = false;
  let spendOk = false;

  // --- vibe_monthly ---
  if (envelope.vibe) {
    let vibeRaw;
    try {
      vibeRaw =
        typeof envelope.vibe === 'string'
          ? JSON.parse(envelope.vibe)
          : envelope.vibe;
    } catch {
      vibeRaw = null;
    }
    const body = vibePayload(vibeRaw);
    if (body && typeof body.usage_percentage === 'number') {
      const remaining = body.usage_percentage;
      const pct = Math.max(0, Math.min(100, 100 - remaining));
      windows.push({
        id: 'vibe_monthly',
        label: 'Vibe',
        letter: 'Vb',
        pct,
        resets_at: body.reset_at ?? nextMonthStartUtc(),
        color: VIBE_COLOR,
        will_deplete: false,
      });
      vibeOk = true;
      // Free-tier UI path; payg_enabled true still isn't a named paid tier here.
      if (body.payg_enabled === false) tier = 'free';
    }
  }

  // --- monthly_spend (optional; needs both legs) ---
  if (envelope.usage && envelope.spend_limit) {
    let usageObj;
    let limitObj;
    try {
      usageObj =
        typeof envelope.usage === 'string'
          ? JSON.parse(envelope.usage)
          : envelope.usage;
      limitObj =
        typeof envelope.spend_limit === 'string'
          ? JSON.parse(envelope.spend_limit)
          : envelope.spend_limit;
    } catch {
      usageObj = null;
      limitObj = null;
    }

    if (usageObj && limitObj && typeof limitObj === 'object') {
      const spend = extractSpendTotal(usageObj);
      const noLimit = Boolean(limitObj.no_monthly_limit);
      const cap =
        typeof limitObj.amount === 'number'
          ? limitObj.amount
          : typeof limitObj.limit === 'number'
            ? limitObj.limit
            : null;

      let pct = null;
      if (!noLimit && cap != null && cap > 0 && spend != null) {
        pct = (100 * spend) / cap;
      } else if (!noLimit && cap != null && cap > 0 && spend === null) {
        // Cap known but spend unreadable → still emit window with null pct
        pct = null;
      } else if (noLimit) {
        pct = null;
      }

      // Emit window whenever spend-limit parsed (optional meter present).
      windows.push({
        id: 'monthly_spend',
        label: 'Spend',
        letter: '$',
        pct,
        resets_at: periodEndFromUsage(usageObj) ?? nextMonthStartUtc(),
        color: SPEND_COLOR,
        will_deplete: false,
      });
      spendOk = true;
    }
  }

  if (!vibeOk && !spendOk) {
    throw new AuthExpiredError(
      'no usable Mistral meter (cookie vibe and/or Admin spend failed)',
    );
  }

  return { tier, windows, segments: [] };
}

function createProvider() {
  let cookie = null;
  let adminKey = null;

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
          { id: 'vibe_monthly', label: 'Vibe', color: VIBE_COLOR },
          { id: 'monthly_spend', label: 'Spend', color: SPEND_COLOR },
        ],
        tiers: ['free'],
      };
    },

    configure(cfg = {}) {
      if (cfg.cookie) cookie = cfg.cookie;
      if (cfg.admin_key) adminKey = String(cfg.admin_key).trim();
      if (cfg.adminKey) adminKey = String(cfg.adminKey).trim();
    },

    async fetch() {
      let vibe = null;
      let usage = null;
      let spend_limit = null;
      let vibeAuthFailed = false;
      let vibeRateLimited = null;
      let spendAuthFailed = false;
      let spendRateLimited = null;
      let hadAdminAttempt = false;

      // --- Vibe (cookie) ---
      if (cookie) {
        try {
          const res = await fetch(VIBE_URL, {
            headers: {
              Cookie: cookie,
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
            },
            redirect: 'manual',
          });
          if (res.status >= 300 && res.status < 400) {
            vibeAuthFailed = true;
          } else if (res.status === 401 || res.status === 403) {
            vibeAuthFailed = true;
          } else if (res.status === 429) {
            vibeRateLimited =
              Number(res.headers.get('retry-after')) || null;
          } else if (res.ok) {
            vibe = await res.text();
          }
          // other HTTP errors: leave vibe null (soft)
        } catch {
          // network — soft fail; may still have spend
        }
      } else {
        vibeAuthFailed = true;
      }

      // --- Admin spend (optional key) ---
      if (adminKey) {
        hadAdminAttempt = true;
        const headers = {
          'x-api-key': adminKey,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        };
        const now = new Date();
        const month = now.getUTCMonth() + 1;
        const year = now.getUTCFullYear();
        const usageUrl = `${ADMIN_BASE}/usage?month=${month}&year=${year}`;
        const limitUrl = `${ADMIN_BASE}/spend-limit`;

        try {
          const [usageRes, limitRes] = await Promise.all([
            fetch(usageUrl, { headers }),
            fetch(limitUrl, { headers }),
          ]);

          if (usageRes.status === 401 || usageRes.status === 403 ||
              limitRes.status === 401 || limitRes.status === 403) {
            spendAuthFailed = true;
          } else if (usageRes.status === 429 || limitRes.status === 429) {
            spendRateLimited =
              Number(
                usageRes.headers.get('retry-after') ||
                  limitRes.headers.get('retry-after'),
              ) || null;
          } else {
            if (usageRes.ok) usage = await usageRes.text();
            if (limitRes.ok) spend_limit = await limitRes.text();
          }
        } catch {
          // soft — vibe may still work
        }
      }

      // Prefer rate-limit signal if that's all we got
      if (!vibe && !usage && !spend_limit) {
        if (vibeRateLimited != null || spendRateLimited != null) {
          throw new RateLimitedError(vibeRateLimited ?? spendRateLimited);
        }
        // Both paths failed auth (or no admin key and cookie dead)
        if (vibeAuthFailed && (!hadAdminAttempt || spendAuthFailed)) {
          throw new AuthExpiredError(
            cookie
              ? 'Mistral cookie expired and Admin spend unavailable'
              : 'no Mistral cookie configured',
          );
        }
        throw new AuthExpiredError('Mistral fetch produced no meter data');
      }

      return JSON.stringify({ vibe, usage, spend_limit });
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
