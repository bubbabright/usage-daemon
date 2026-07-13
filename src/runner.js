// The runner schedules each configured provider on its own interval, normalizes
// its raw parse into the A2 snapshot, stores history, computes will_deplete, and
// keeps the last-known snapshot per provider (fail-soft: errors mark stale, never
// blank).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { willDeplete } from './burnrate.js';

const STATUS = {
  OK: 'ok',
  AUTH_EXPIRED: 'auth_expired',
  RATE_LIMITED: 'rate_limited',
  ERROR: 'error',
};

export class Runner {
  constructor() {
    this.providers = new Map(); // name -> { provider, timer, cookieFile }
    this.current = new Map();   // name -> snapshot
  }

  add(provider, meta = {}) {
    const name = provider.id;
    this.providers.set(name, {
      provider,
      timer: null,
      cookieFile: meta.cookieFile ?? null,
    });
  }

  // Persist a session cookie for a provider (daemon stays the owner: it holds,
  // writes, and uses it), reconfigure the plugin, then poll immediately. Lets a
  // client (the extension prefs) supply the cookie without the daemon ever
  // handing it back out. Returns the fresh snapshot.
  async setCookie(name, cookie) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    const value = String(cookie ?? '').trim();
    if (!value) throw new Error('empty cookie');
    if (entry.cookieFile) {
      await fs.mkdir(path.dirname(entry.cookieFile), { recursive: true });
      await fs.writeFile(entry.cookieFile, value + '\n', { mode: 0o600 });
    }
    entry.provider.configure?.({ cookie: value });
    return this.poll(name);
  }

  list() {
    return [...this.providers.keys()].map((name) => {
      const snap = this.current.get(name);
      return {
        provider: name,
        status: snap?.status ?? 'pending',
        stale: snap?.stale ?? true,
        t: snap?.t ?? null,
      };
    });
  }

  getCurrent(name) {
    return this.current.get(name) ?? null;
  }

  async getHistory(name) {
    return store.read(name);
  }

  start() {
    for (const { provider } of this.providers.values()) {
      const secs = provider.intervalSeconds?.() ?? 300;
      // poll once immediately, then on interval
      this.poll(provider.id);
      const entry = this.providers.get(provider.id);
      entry.timer = setInterval(() => this.poll(provider.id), secs * 1000);
      if (entry.timer.unref) entry.timer.unref();
    }
  }

  stop() {
    for (const entry of this.providers.values()) {
      if (entry.timer) clearInterval(entry.timer);
      entry.timer = null;
    }
  }

  // Poll one provider now. Returns the resulting snapshot.
  async poll(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    const { provider } = entry;
    const t = Date.now();
    try {
      const raw = await provider.fetch();
      const parsed = provider.parse(raw); // { tier, windows, segments }
      const history = await store.read(name);
      const windows = parsed.windows.map((w) => ({
        ...w,
        will_deplete: willDeplete(history, w.id, w.pct, w.resets_at, t),
      }));
      const snapshot = {
        provider: name,
        t,
        tier: parsed.tier,
        status: STATUS.OK,
        stale: false,
        windows,
        segments: parsed.segments ?? [],
      };
      this.current.set(name, snapshot);
      await store.append(name, snapshot);
      return snapshot;
    } catch (err) {
      return this._markStale(name, t, err);
    }
  }

  // Keep last-known values, flag stale + status. Never blank.
  _markStale(name, t, err) {
    const prev = this.current.get(name);
    const status =
      err?.code === 'auth_expired'
        ? STATUS.AUTH_EXPIRED
        : err?.code === 'rate_limited'
          ? STATUS.RATE_LIMITED
          : STATUS.ERROR;
    const snapshot = {
      provider: name,
      t: prev?.t ?? t, // keep the last *successful* timestamp if we have one
      tier: prev?.tier ?? 'unknown',
      status,
      stale: true,
      error: err?.message ?? String(err),
      windows: prev?.windows ?? [],
      segments: prev?.segments ?? [],
    };
    this.current.set(name, snapshot);
    return snapshot;
  }
}