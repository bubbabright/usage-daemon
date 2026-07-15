# usage-daemon

Localhost daemon that owns usage polling for the GNOME usage suite. **Node/JS**,
zero runtime dependencies. A **framework + runner**; each provider is a compiled-in
**plugin**. Ollama and Claude Code are the first two providers. Binds
`127.0.0.1:8787` only.

## Install / update

```sh
curl -fsSL https://raw.githubusercontent.com/bubbabright/usage-daemon/main/install.sh | bash
```

Idempotent — **the same command is how you update**: re-run it any time to pull the
latest and restart. It clones (or `git pull --ff-only` on an existing install) into
`~/.local/share/usage-daemon`, checks Node.js ≥ 20 is on `PATH`, writes a default
`~/.config/usage-daemon/config.toml` on first run only (never overwrites an existing
one), and sets up a `systemd --user` service so it survives reboots — or, on a host
with no systemd `--user` session, just leaves the code in place and prints the
manual run command (`node src/index.js`).

Refuses to pull over local modifications (protects a from-source dev checkout run
the same way) rather than silently discarding them.

Prefer a local clone? `git clone https://github.com/bubbabright/usage-daemon.git &&
cd usage-daemon && ./install.sh` does the same thing.

> **If you're hacking on a checkout you run directly** (like this repo's own dev
> setup), don't point `install.sh` at it — it always manages its own separate copy
> under `~/.local/share/usage-daemon`. Wire your dev checkout to systemd by hand (see
> the unit `install.sh` generates, above) so there's exactly one `usage-daemon`
> process on port 8787 either way.

`scripts/restart-daemon.sh` / `scripts/update-prod.sh` are a **different**,
pidfile + `nohup`-based deploy path for pushing a dev checkout to a remote host over
SSH (no systemd assumed) — don't run them against a host `install.sh` already set up,
or you'll end up with two daemons fighting over the port.

Full interactive installer (provider toggles, bind address, MCP/dashboard/health
toggles) is still on the roadmap — see below.

## Why a daemon

One poller kills the duplicate-request 429 risk. It owns auth, parsing, history,
and burn-rate, and serves a provider-agnostic `windows[]` snapshot so one client
and one report can serve every provider.

The daemon is the **optional** hub of the two-direction usage system
(`../README.md`), not a hard dependency:

- **Direction 1, standalone exts.** Each per-provider GNOME ext (claude, grok, ollama)
  works with **no daemon**: its own engine polls upstream directly. That's the common
  case, one provider. When the daemon *is* running, a dual-mode ext can read it
  instead of polling.
- **Direction 2, unified ext + MCP.** For multi-provider power users: one ext presents
  **any** provider the daemon publishes, and a **generic (provider-agnostic) MCP server**
  exposes `get_usage(provider)` to *any* MCP client, not just Claude Code, not claude-only.

## MCP server (generic): the orchestration control plane

The daemon backs a thin MCP server over the same provider registry. It is **provider-agnostic**:
any MCP client can query usage for any configured provider (claude, grok, ollama, future
plugins) uniformly. Not coupled to Claude.

**Core purpose: it's a control plane, not a dashboard.** Live cross-provider quota state is a
**cost-aware inference-orchestration signal** for local infra: **LiteLLM, the olla LLM proxy,
Celery batch queues**. It informs **when and which serverless GPU node to spin up** (RTX
3000-series → 4000-series → H100 …), under one rule: **drain already-paid subscription/API quota
first, use free/cheap pay-as-you-go inference next, and rent a bigger GPU only when necessary.**
Waterfall dispatch:

```
already-paid subscription quota  →  free/cheap serverless  →  bigger GPU only when needed
```

This is consistent with my "never auto-spend quota to refresh a *status* token" rule: don't waste
spend, but do route real work to capacity already paid for before renting more. (It generalizes the
old Phase-2 "ROI scheduler" from one provider to the whole inference fleet.)

## Run

```bash
node src/index.js          # or: npm start
npm test                   # fixture-driven unit tests (node:test)
```

Config: `~/.config/usage-daemon/config.toml` (see `config.example.toml`). If it's missing,
ollama is enabled at 300s with no cookie, so it reports `auth_expired` and keeps last-known
values (it never blanks).

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

Ollama's website auths on the browser **session cookie** (not the API key). There are two
ways to give it to the daemon; either way the **daemon owns it** (holds it, persists it to
`cookie_file` at mode `0600`, and uses it; it's never returned by any endpoint):

- **File:** paste it into the `cookie_file` from `config.toml` and restart.
- **Endpoint** (what the GNOME extension prefs uses): `POST /usage/ollama/cookie`
  with the cookie as `text/plain` or `{"cookie":"..."}` JSON. The daemon writes it to
  `cookie_file` and immediately re-polls. Localhost only.

```bash
curl -X POST --data 'session=...; other=...' 127.0.0.1:8787/usage/ollama/cookie
```

### Snapshot (the daemon-to-client contract)

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

**`windows[]` array order IS display order** — no client sorts by duration (report.js,
dashboard.js, multi-provider-extension all just `windows.map`/`forEach` in array order).
Convention: **shorter-duration window first** — claude/ollama emit `[session, weekly]`;
grok emits `[weekly, monthly]`. A provider's `parse()` must build the array in that order,
not fetch/computation order (grok's monthly transport is fetched first but must still be
placed *second* in the returned array).

All datetime fields (`resets_at`, `token_expires_at`) are normalized to the **host's local
time zone** (the LXC/Docker container's TZ) as ISO-8601 with an explicit offset, e.g.
`2026-07-31T20:00:00-04:00` — one representation regardless of what each upstream API emits
(`src/time.js`). The instant is unchanged, so relative "resets in Xh" math is unaffected.

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
    claude.js    poll api.anthropic.com/api/oauth/usage (oauth-file auth) + PURE parse(json)
test/
  ollama.test.js parse + burnrate, against the real page fixture
  claude.test.js parse, against the real API response fixture
```

## Storage: aggregate SQLite (planned)

The daemon will store **aggregate usage for all providers in one SQLite DB**. This
**eliminates the extension's history size/perf limit**: the exts cap history at a ~20k-line
JSONL ring buffer because they run in the **GNOME compositor thread** (unbounded history
there means jank; see `../todo/done/HANDOFF-1-history-bounding.md`). The daemon is a
**separate process**, so that ceiling doesn't apply. It can keep full history in SQLite,
unbounded.

(Current code: per-provider `history.jsonl` via `store.js`. This migrates to the aggregate
SQLite store; the normalized `windows[]` snapshot stays the write contract.)

**Future:** export to **Prometheus / Grafana / etc.** SQLite gives a clean query/export
surface for time-series dashboards and alerting beyond the built-in HTML report.

## Always-on service (LXC 24/7 + mobile)

Running the daemon in an **LXC gives 24/7 collection independent of the daily-driver desktop**.
A few consequences:

- **Complete history, captures automated/background spend.** The desktop being off no longer
  means a data gap. **Scheduled/automated consumers burn quota while you're away**: Claude
  scheduled tasks, cron agents, background coworkers. An ext-only collector is asleep when that
  runs, so it doesn't see that spend. (This isn't "ext-only is wrong." For a user with no
  off-session automated consumers, the ext is already complete. The always-on daemon matters
  precisely when such consumers exist.) Burn-rate and projection accuracy improve from having
  no uptime holes and no invisible-consumer holes.
- **Mobile use.** Usage is collected continuously and served beyond the GNOME panel + MCP.
- **On-the-go dashboard via Tailscale.** Expose the dashboard over a **Tailscale** private mesh
  for an all-providers view from your phone. Tailscale is also the clean answer to the
  remote-bind security question: bind the daemon to the **Tailscale interface** (authenticated
  private mesh) rather than a public `0.0.0.0` bind behind hand-rolled firewalling, so it's
  reachable from your devices and invisible to LAN/internet.

## Full interactive installer (planned)

`install.sh` (above) covers install + update + systemd today. The rest of this
**idempotent, interactive installer** (re-runnable, reconfigures in place, never
double-installs) is still planned. On each run it will offer:

1. ~~**Update from GitHub**: pull the latest daemon.~~ — done, `install.sh`.
2. **Change providers**: enable/disable/configure which provider plugins run.
3. **Change bind address**: default `127.0.0.1:8787` (localhost-only); set a LAN IP / `0.0.0.0`
   for remote clients (e.g. a GNOME ext on another host pointing at the daemon in an LXC). This
   is the knob that opens the remote-serving path, so pair it with LAN-only firewalling / access
   control, since binding off localhost trades away the localhost-only safety posture.
4. **Change autostart behavior**: enable/disable service autostart (systemd unit).
5. **Serve health URL**: a health endpoint (e.g. for a dashboard / uptime check).
6. **Serve MCP**: enable the generic, provider-agnostic MCP server.
7. **Serve dashboard**: enable the HTML dashboard/report surface.

Each toggle is independent and persists to config; re-running the installer just re-presents
the current state for editing.

### Config UX progression (planned)

- **Early: manual config file + scp/ssh.** Advanced users can edit the config directly (and push
  it over scp/ssh). This is available *before* the richer UIs, so nobody's blocked waiting on them.
- **Later: full TUI and web GUI.** Both target the same config the installer/manual edit write.
- **Web GUI, easy cookie copy-paste (key requirement).** Cookie entry is the real friction
  point for cookie-auth providers (ollama, grok-weekly). The web GUI needs to make pasting a
  session cookie trivial. (The daemon owns the cookie; see "Supplying the cookie" above.)

> **Config format: TOML, decided (2026-07-13).** No YAML. Reasons, in order: (1) **no
> indentation/whitespace footguns**, which matters most for the early hand-edit-over-ssh path;
> you can't silently break structure with a bad tab. (2) **Zero-dep**: `config.js` already
> hand-rolls a minimal TOML loader, and YAML would pull in `js-yaml` and break the daemon's
> zero-runtime-dep stance. (3) **Cookie strings**: TOML literal strings (`'...'`) need no
> escaping for the `; = : / +` characters in session cookies; YAML would need careful quoting.
> (4) Explicit types, no YAML coercion traps (the "Norway problem"). YAML's one edge, familiarity,
> is weak here since most config flows through the installer / TUI / web GUI anyway.

## Adding a provider

1. `src/providers/<name>.js` exporting `createProvider()` → `{ name, configure, intervalSeconds, poll }`.
   `poll()` returns `{ tier, windows, segments }`; keep any HTML scrape in a **pure**
   `parse()` for fixture testing.
2. `registry.register('<name>', createProvider)` in `index.js`.
3. Enable it in config. No dynamic plugin loading, it's compiled in on purpose.
4. Order `windows[]` **shorter-duration first** — see the snapshot contract note above. Easy
   to miss: grok shipped with it backwards ([monthly, weekly]) because that matched fetch
   order, not display order — caught after it rendered wrong in multi-provider-extension.

## Related projects

- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension) — standalone, no daemon needed.
- [grok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension) — standalone, no daemon needed.
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension) — thin client, requires this daemon.
