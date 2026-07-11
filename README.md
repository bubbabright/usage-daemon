# usage-daemon

Localhost daemon that owns usage polling for the GNOME usage suite. **Node/JS**,
zero runtime dependencies. A **framework + runner**; each provider is a compiled-in
**plugin**. Ollama is the first provider. Binds `127.0.0.1:8787` only.

## Why a daemon

Single poller (kills the duplicate-request 429 risk), owns auth + parsing + history +
burn-rate, serves a provider-agnostic `windows[]` snapshot so one client + report serve
every provider. Extensions become thin display clients.

## Run

```bash
node src/index.js          # or: npm start
npm test                   # fixture-driven unit tests (node:test)
```

Config: `~/.config/usage-daemon/config.toml` (see `config.example.toml`). Missing = ollama
enabled at 300s but no cookie → it reports `auth_expired` and keeps last-known (never blanks).

## HTTP surface

| Method | Path | Returns |
|---|---|---|
| GET | `/usage/providers` | configured providers + status |
| GET | `/usage/{provider}/current` | normalized snapshot (below) |
| GET | `/usage/{provider}/history` | history rows `{t, session, weekly, tier}` |
| POST | `/usage/{provider}/refresh` | force an immediate poll, return snapshot |
| POST | `/usage/{provider}/cookie` | store the session cookie (daemon owns it), re-poll |
| GET | `/?provider={name}` | self-contained HTML report (fetches history live) |

### Supplying the cookie

Ollama's website auths on the browser **session cookie** (not the API key). Two ways
to give it to the daemon — either way the **daemon owns it** (holds, persists to
`cookie_file` at mode `0600`, and uses it; it is never returned by any endpoint):

- **File:** paste it into the `cookie_file` from `config.toml` and restart.
- **Endpoint** (what the GNOME extension prefs uses): `POST /usage/ollama/cookie`
  with the cookie as `text/plain` or `{"cookie":"..."}` JSON. The daemon writes it to
  `cookie_file` and immediately re-polls. Localhost only.

```bash
curl -X POST --data 'session=...; other=...' 127.0.0.1:8787/usage/ollama/cookie
```

### Snapshot (the daemon↔client contract)

```json
{
  "provider": "ollama", "t": 1783250789974, "tier": "free",
  "status": "ok", "stale": false,
  "windows": [
    {"id":"session","label":"Session","pct":0,"resets_at":"2026-07-11T10:00:00Z","color":"#E69F00","will_deplete":false},
    {"id":"weekly","label":"Weekly","pct":0,"resets_at":"2026-07-13T00:00:00Z","color":"#56B4E9","will_deplete":false}
  ],
  "segments": []
}
```

`status`: `ok | auth_expired | rate_limited | error`. On any error the daemon keeps the
last-known `windows` and sets `stale:true`.

## Layout

```
src/
  index.js       entry: load config, register providers, start runner + HTTP
  config.js      minimal TOML loader (zero-dep)
  registry.js    compiled-in provider registry (name -> factory)
  runner.js      scheduler; normalizes to snapshot, stores history, computes will_deplete
  store.js       per-provider history.jsonl (~/.local/state/usage-daemon/<p>/)
  burnrate.js    least-squares slope + depletion projection
  http.js        localhost HTTP surface
  report.js      self-contained HTML report (live-fetches history)
  providers/
    ollama.js    poll ollama.com/settings (cookie auth) + PURE parse(html)
test/
  ollama.test.js parse + burnrate, against the real page fixture
```

## Adding a provider

1. `src/providers/<name>.js` exporting `createProvider()` → `{ name, configure, intervalSeconds, poll }`.
   `poll()` returns `{ tier, windows, segments }`; keep any HTML scrape in a **pure**
   `parse()` for fixture testing.
2. `registry.register('<name>', createProvider)` in `index.js`.
3. Enable it in config. No dynamic plugin loading — compiled in on purpose.
