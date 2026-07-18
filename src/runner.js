// The runner schedules each configured provider on its own interval, normalizes
// its raw parse into the A2 snapshot, stores history, computes will_deplete, and
// keeps the last-known snapshot per provider (fail-soft: errors mark stale, never
// blank).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { willDeplete } from './burnrate.js';
import { toHostIso } from './time.js';

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

  // Flush a stored cookie: delete the on-disk file (if any), clear the
  // in-memory value on the live plugin instance, then poll immediately so
  // the resulting snapshot reflects the cleared state (auth_expired) rather
  // than the last-good one lingering until the next scheduled poll. The
  // empty-string configure() only actually clears anything because provider
  // configure() implementations check `!== undefined`, not truthiness — see
  // the comment at each provider's own configure().
  async clearCookie(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new Error(`unknown provider: ${name}`);
    if (entry.cookieFile) {
      await fs.rm(entry.cookieFile, { force: true });
    }
    entry.provider.configure?.({ cookie: '' });
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
      const windows = parsed.windows.map((w) => {
        const resets_at = toHostIso(w.resets_at); // one representation for all providers
        return {
          ...w,
          resets_at,
          will_deplete: willDeplete(history, w.id, w.pct, resets_at, t),
        };
      });
      const meta = provider.meta?.() ?? {}; // optional hook; undefined for ollama today
      if (meta.token_expires_at) meta.token_expires_at = toHostIso(meta.token_expires_at);
      const snapshot = {
        provider: name,
        t,
        tier: parsed.tier,
        status: STATUS.OK,
        stale: false,
        windows,
        segments: parsed.segments ?? [],
        ...meta,
      };
      this.current.set(name, snapshot);
      await store.append(name, snapshot);
      return snapshot;
    } catch (err) {
      return this._markStale(name, t, err);
    }
  }

  // Keep last-known values, flag stale + status. Never blank.
  //
  // `prev` only covers snapshots THIS process has produced — a daemon
  // restart wipes it even though the provider may have years of good polls
  // on disk. Without a disk fallback, a provider whose auth already expired
  // *before* a restart (nothing to re-populate `current` with) renders as
  // empty forever, even though store.js has its last-known percentages.
  // Disk history rows are compact (`{t, tier, <window.id>: pct}`, no
  // label/color/resets_at — see store.js historyRow), so windows rebuilt
  // from disk borrow label/color from the provider's own static config()
  // and leave resets_at null (the old value would be stale past meaning,
  // not just imprecise) and will_deplete false (nothing to project from a
  // single point).
  async _markStale(name, t, err) {
    const prev = this.current.get(name);
    const status =
      err?.code === 'auth_expired'
        ? STATUS.AUTH_EXPIRED
        : err?.code === 'rate_limited'
          ? STATUS.RATE_LIMITED
          : STATUS.ERROR;

    let windows = prev?.windows ?? null;
    let tier = prev?.tier ?? null;
    let lastT = prev?.t ?? null;
    if (windows == null) {
      const history = await store.read(name);
      const last = history[history.length - 1];
      if (last) {
        const entry = this.providers.get(name);
        const cfgWindows = entry?.provider.config?.()?.windows ?? [];
        const cfgById = new Map(cfgWindows.map((w) => [w.id, w]));
        windows = Object.keys(last)
          .filter((k) => k !== 't' && k !== 'tier')
          .map((id) => ({
            id,
            label: cfgById.get(id)?.label ?? id,
            pct: last[id],
            resets_at: null,
            color: cfgById.get(id)?.color ?? null,
            will_deplete: false,
          }));
        tier = last.tier ?? tier;
        lastT = last.t ?? lastT;
      }
    }

    const snapshot = {
      provider: name,
      t: lastT ?? t, // keep the last *successful* timestamp if we have one
      tier: tier ?? 'unknown',
      status,
      stale: true,
      error: err?.message ?? String(err),
      windows: windows ?? [],
      segments: prev?.segments ?? [],
    };
    this.current.set(name, snapshot);
    return snapshot;
  }
}