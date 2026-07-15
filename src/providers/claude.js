// Claude Code usage provider plugin — descriptor interface (HANDOFF-14).
//
// Reads the OAuth usage endpoint with the same accessToken the `claude` CLI
// itself uses (~/.claude/.credentials.json). READ-ONLY: this daemon never
// writes that file and never refreshes the token — expired/missing token
// just reports auth_expired (see AuthExpiredError below); the CLI or `claude
// login` remain the only things that mutate it.
//
// parse() is a PURE function of the raw JSON text so it unit-tests against
// the vendored fixture (test/fixtures/claude-usage.json) with no network/fs.
// fetch() adds the credentials read + HTTP fetch + auth-expiry detection
// around it. Field mapping ported verbatim from
// claude-usage-extension/extension.js (the live extractor is the spec).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSION_COLOR = '#E69F00'; // Okabe-Ito orange (suite-wide)
export const WEEKLY_COLOR = '#56B4E9';  // Okabe-Ito blue

export const ID = 'claude';
export const LABEL = 'Claude Code';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
// Anthropic buckets requests without this UA into aggressive 429s — see
// anthropics/claude-code#31021, #30930, #31637 (same requirement as the ext).
const CLAUDE_USER_AGENT = 'claude-code/2.1.0';

export class AuthExpiredError extends Error {
  constructor(msg = 'Claude Code token missing or expired') {
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

function defaultCredentialsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, '.credentials.json');
}

// Pure function of the raw API JSON text — no fs/network. Throws
// AuthExpiredError if the payload doesn't look like a usage response
// (mirrors ollama's parse throwing on a logged-out page).
export function parse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AuthExpiredError('unparseable usage response');
  }
  if (!data?.five_hour || !data?.seven_day) throw new AuthExpiredError();

  const windows = [
    {
      id: 'session',
      label: '5h',
      letter: '5h',
      pct: data.five_hour.utilization ?? null,
      resets_at: data.five_hour.resets_at ?? null,
      color: SESSION_COLOR,
      will_deplete: false,
    },
    {
      id: 'weekly',
      label: '7d',
      letter: 'Wk',
      pct: data.seven_day.utilization ?? null,
      resets_at: data.seven_day.resets_at ?? null,
      color: WEEKLY_COLOR,
      will_deplete: false,
    },
  ];

  return { tier: null, windows, segments: [] };
}

function createProvider() {
  let credentialsPath = defaultCredentialsPath();
  let lastTokenExpiresAt = null; // surfaced via meta() — set on each successful credentials read

  return {
    id: ID,
    label: LABEL,
    auth: { kind: 'oauth-file' },

    config() {
      return {
        id: ID,
        label: LABEL,
        auth: { kind: 'oauth-file' },
        windows: [
          { id: 'session', label: '5h', color: SESSION_COLOR },
          { id: 'weekly', label: '7d', color: WEEKLY_COLOR },
        ],
        tiers: [],
      };
    },

    configure(cfg = {}) {
      if (cfg.credentialsPath) credentialsPath = cfg.credentialsPath;
    },

    async fetch() {
      let accessToken;
      try {
        const raw = await fs.readFile(credentialsPath, 'utf8');
        const json = JSON.parse(raw);
        accessToken = json?.claudeAiOauth?.accessToken;
        lastTokenExpiresAt = json?.claudeAiOauth?.expiresAt ?? null;
      } catch {
        throw new AuthExpiredError('no Claude Code credentials file found');
      }
      if (!accessToken) throw new AuthExpiredError('no accessToken in credentials file');

      const res = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': CLAUDE_USER_AGENT,
        },
      });
      if (res.status === 401) throw new AuthExpiredError();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw new RateLimitedError(retryAfter);
      }
      if (!res.ok) throw new Error(`api.anthropic.com HTTP ${res.status}`);
      return res.text();
    },

    intervalSeconds() {
      return 300;
    },

    // Optional generic hook (runner merges this into the snapshot if
    // present) — surfaces facts that live outside the parsed payload, here
    // the credentials file's own expiry, not part of the usage API response.
    meta() {
      return { token_expires_at: lastTokenExpiresAt };
    },

    parse,
  };
}

export { createProvider };
