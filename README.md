# usage-daemon

Localhost (or always-on LXC) daemon that **owns** usage polling for my GNOME usage suite.
**Node/JS**, zero runtime dependencies. Framework + runner. Each provider is a compiled-in
**plugin**. Plugins today: **ollama**, **claude**, **grok**, **mistral**. Default bind: `127.0.0.1:8787`.

## One line

One poller. One secret store. One `windows[]` snapshot. Every thin client is just a view.

## Why I run a daemon

Without it, every panel and every laptop polls Anthropic / xAI / ollama.com on its own timer.
With a shared subscription and several humans (plus agents), that is uncoordinated sources of
truth against APIs that already rate-limit chatter.

The daemon is the **optional** hub of the two-direction system (see the meta
[`../README.md`](../README.md)), not a hard dependency.

- **Solo path:** Claude and Grok GNOME exts still self-poll with their own engines. Dual-mode
  (prefer this daemon when it is up) is the plan, not fully wired in every ext yet. Ollama's
  GNOME ext is a thin client of this daemon today.
- **Hub path:** [multi-provider-usage-extension](https://github.com/bubbabright/multi-provider-usage-extension)
  and the web dashboard at `GET /` read the same registry. Add a plugin here → multi lights up
  with **no extension code change**. I proved that with Grok.

I own auth handling, parse, history, burn-rate, and polling interval. Clients render. Cookie
endpoints never echo the cookie back. OAuth-file plugins read the same credentials file the
CLI already owns, **read-only**, and **never refresh the token** (expired → `auth_expired`,
last-known windows stay).

## Install / update

```sh
curl -fsSL https://raw.githubusercontent.com/bubbabright/usage-daemon/main/install.sh | bash
```

Idempotent. **The same command is how I update**: re-run it any time to pull the latest and
restart. It clones (or `git pull --ff-only` on an existing install) into
`~/.local/share/usage-daemon`, checks Node.js ≥ 20 is on `PATH`, writes a default
`~/.config/usage-daemon/config.toml` on first run only (never overwrites an existing one),
and sets up a `systemd --user` service so it survives reboots. On a host with no systemd
`--user` session, it leaves the code in place and prints the manual run command
(`node src/index.js`).

Refuses to pull over local modifications (protects a from-source dev checkout) rather than
silently discarding them.

Prefer a local clone?

```sh
git clone https://github.com/bubbabright/usage-daemon.git
cd usage-daemon && ./install.sh
```

`install.sh` always manages its **own** copy under `~/.local/share/usage-daemon`. If I am
hacking on a checkout I run directly, I do not point `install.sh` at it. I wire that checkout
to systemd by hand (see the unit `install.sh` generates) so there is exactly one process on
port 8787.

`scripts/restart-daemon.sh` / `scripts/update-prod.sh` are a **different**, pidfile +
`nohup`-based deploy path for pushing a dev checkout to a remote host over SSH (no systemd
assumed). Do not run them against a host `install.sh` already set up, or two daemons fight
over the port.

Full interactive installer (provider toggles, bind address, MCP/dashboard/health toggles) is
still on the roadmap. See below.

## MCP server (planned): control plane, not a second dashboard

Not implemented in this tree yet. **Build order:**
[`../todo/HANDOFF-22-usage-daemon-mcp.md`](../todo/HANDOFF-22-usage-daemon-mcp.md).
Thin MCP server over the **same** provider registry: provider-agnostic
`get_usage(provider)` for any MCP client, not Claude-only.

**Core purpose: control plane, not a dashboard.** Live cross-provider quota state is a
cost-aware inference-orchestration signal for local infra (LiteLLM, olla, batch queues).
Rule of thumb:

```
already-paid subscription headroom  →  free/cheap serverless  →  bigger GPU only when needed
```

Gateways know dollars through the pipe. They usually do not know what is left on my Claude
weekly window while Claude Code and night agents burn it outside the proxy. This layer is
that headroom.

Consistent with: **never auto-spend quota just to refresh a status token.**

## Run

```bash
node src/index.js          # or: npm start
npm test                   # fixture-driven unit tests (node:test)
```

Config: `~/.config/usage-daemon/config.toml` (see `config.example.toml`). Providers are
enabled there with per-provider intervals and auth paths. Ollama needs a session cookie
(file or paste). Claude reads `~/.claude/.credentials.json`. Grok reads `~/.grok/auth.json`.
Mistral needs an `admin.mistral.ai` session cookie for the free Vibe meter (same cookie
POST path as ollama); optional Admin-role API key (`admin_key` / `admin_key_file`) adds the
`$` monthly spend window. Default `enabled = false` until a cookie is present.

## HTTP surface

| Method | Path | Returns |
|---|---|---|
| GET | `/usage/providers` | configured providers + status |
| GET | `/usage/{provider}/config` | metadata (label, `auth.kind`, window descriptors) |
| GET | `/usage/{provider}/icon` | icon bytes (`?variant=` optional) |
| GET | `/usage/{provider}/icons` | list of icon variants |
| GET | `/usage/{provider}/current` | normalized snapshot (below) |
| GET | `/usage/{provider}/history` | history rows (window ids as keys, plus `t`, `tier`) |
| POST | `/usage/{provider}/refresh` | force an immediate poll, return snapshot |
| POST | `/usage/{provider}/cookie` | store session cookie (daemon owns it), re-poll |
| GET | `/` | multi-provider **dashboard** (provider multi-select, cards, cookie paste for cookie auth) |
| GET | `/?provider={name}` | self-contained HTML **report** for one provider (fetches history live) |

There is no `/timeline` route yet. Interactive multi-series history is planned
(`todo/HANDOFF-18-timeline-how-did-i-get-here.md`).

### Supplying the cookie (cookie-auth providers)

Ollama and Mistral auth on the browser **session cookie** (not the inference API key).
Claude and Grok do **not** use this path (`auth.kind: oauth-file`). Either way the
**daemon owns** cookie secrets: persists to `cookie_file` at mode `0600`, uses them,
**never returns them** from any endpoint.

- **File:** put the cookie in the path from `config.toml` and restart (or wait for next poll).
- **Endpoint** (what the GNOME prefs and the web dashboard use):
  `POST /usage/{provider}/cookie` with the cookie as `text/plain` or `{"cookie":"..."}` JSON.
  The daemon writes it and immediately re-polls. Localhost only by default.

```bash
curl -X POST --data 'session=...; other=...' 127.0.0.1:8787/usage/ollama/cookie
curl -X POST --data-binary @mistral.cookie 127.0.0.1:8787/usage/mistral/cookie
```

### Snapshot (daemon-to-client contract)

```json
{
  "provider": "ollama",
  "t": 1783250789974,
  "tier": "free",
  "status": "ok",
  "stale": false,
  "windows": [
    {
      "id": "session",
      "label": "Session",
      "pct": 0,
      "resets_at": "2026-07-11T10:00:00-04:00",
      "color": "#E69F00",
      "will_deplete": false
    },
    {
      "id": "weekly",
      "label": "Weekly",
      "pct": 0,
      "resets_at": "2026-07-13T00:00:00-04:00",
      "color": "#56B4E9",
      "will_deplete": false
    }
  ],
  "segments": []
}
```

`status`: `ok | auth_expired | rate_limited | error`. On any error the daemon keeps the
last-known `windows` and sets `stale: true`. Never invents zero to look fresh.

**`windows[]` array order is display order.** Clients (`dashboard.js`, `report.js`,
multi-provider-extension) map / forEach in array order. They do not sort by duration.

What plugins actually emit on `/current` today (from each plugin's `parse()`):

| Provider | Order in snapshot |
|---|---|
| ollama | `session`, then `weekly` |
| claude | `session` (5h), then `weekly` (7d) |
| grok | `weekly`, then `monthly` |
| mistral | `vibe_monthly` (Vb), then optional `monthly_spend` ($) |

`config().windows` is metadata for reports/UI labels. For grok, config currently lists
`monthly` then `weekly` while live snapshots use weekly then monthly. **Trust `/current`
for bar order.** When I write a plugin I still try to keep config and parse aligned.

**User knows all:** the dashboard lets me multi-select which **providers** to show
(`?p=` + `sessionStorage`). Choosing which **windows** to chart on one timeline is the
timeline job (planned). One provider's short window can match another's long. Short-first
is a useful author convention, not a forced band for every viewer.

All datetime fields (`resets_at`, `token_expires_at`) are normalized to the **host's local
time zone** (the LXC/Docker container's TZ) as ISO-8601 with an explicit offset, e.g.
`2026-07-31T20:00:00-04:00` (`src/time.js`). The instant is unchanged, so relative
"resets in Xh" math is unaffected.

Optional `meta()` (claude, grok) may add fields such as `token_expires_at` onto the snapshot.

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
  dashboard.js   multi-provider HTML dashboard (GET /)
  report.js      self-contained HTML report (live-fetches history)
  time.js        host-local ISO timestamps
  providers/
    ollama.js    poll ollama.com/settings (cookie) + pure parse(html)
    claude.js    poll api.anthropic.com/api/oauth/usage (oauth-file) + pure parse(json)
    grok.js      monthly billing + weekly gRPC-web (oauth-file) + pure parse(envelope)
    mistral.js   vibe tRPC (cookie) + optional Admin /usage÷spend-limit + pure parse(envelope)
test/
  …              fixture-driven parse / burnrate tests
```

## Storage: aggregate SQLite (planned)

Today: per-provider `history.jsonl` via `store.js`, trimmed to ~20k lines (same ceiling
idea as the desktop exts).

Planned: **one SQLite DB** for all providers so history is not capped by the GNOME
compositor thread the way extension rings are. The daemon is a separate process; that
ceiling need not apply. The write contract stays the normalized snapshot / window ids.

**Future:** export to Prometheus / Grafana / Power BI. Built-in interactive timeline is for
"how did I get here?" Deep BI stays export.

## Always-on service (LXC 24/7 + mobile)

Running the daemon in an **LXC** gives 24/7 collection independent of the daily-driver
desktop.

- **Complete history, captures automated / background spend.** Desktop off no longer means
  a data gap. Scheduled tasks, cron agents, background coworkers burn quota while I am away.
  An ext-only collector is asleep then. For a user with no off-session consumers, the ext is
  already complete. Always-on matters when those consumers exist.
- **Mobile use.** Continuous collection, served beyond the GNOME panel.
- **On-the-go dashboard via Tailscale.** Expose the dashboard over a Tailscale private mesh.
  Prefer binding to the Tailscale interface over a public `0.0.0.0` behind hand-rolled
  firewalling.

## Full interactive installer (planned)

`install.sh` (above) covers install + update + systemd today. The rest of an **idempotent,
interactive installer** (re-runnable, reconfigures in place, never double-installs) is still
planned. On each run it should offer:

1. ~~Update from GitHub~~ (done, `install.sh`).
2. **Change providers**: enable/disable/configure plugins.
3. **Change bind address**: default `127.0.0.1:8787`; LAN / Tailscale bind for remote clients.
   Binding off localhost trades away the localhost-only safety posture. Pair with real access
   control.
4. **Change autostart**: enable/disable systemd user unit.
5. **Serve health URL**.
6. **Serve MCP** (when implemented).
7. **Serve dashboard** (dashboard already exists at `GET /`; installer toggle still planned).

### Config UX progression (planned)

- **Early: manual config file + scp/ssh.** Available now. Nobody waits on richer UIs.
- **Later: full TUI and web GUI** against the same config.
- **Web GUI, easy cookie paste (key requirement).** Cookie entry is the real friction for
  cookie-auth providers. Dashboard already has per-card cookie send for cookie auth. Daemon
  still owns the secret.

> **Config format: TOML, decided.** No YAML. (1) No indentation footguns for hand-edit over
> ssh. (2) Zero-dep: `config.js` hand-rolls a minimal TOML loader. (3) Cookie strings: TOML
> literal strings need no escaping for `; = : / +`. (4) Explicit types, no YAML coercion
> traps. Familiarity is not enough to justify YAML here.

## Adding a provider

1. `src/providers/<name>.js` exporting `createProvider()` → object with
   `name`/`label`, `auth`, `config()`, `configure(cfg)`, `intervalSeconds()`, `fetch()`,
   pure `parse(raw)` → `{ tier, windows, segments }`, optional `meta()`.
2. `registry.register('<name>', createProvider)` in `index.js` (compiled in on purpose).
3. Enable it in `config.toml`.
4. Order `windows[]` the way clients should show bars by default. Align `config().windows`
   with `parse()` order. Keep pure `parse()` fixture-tested under `test/`.

Auth kinds clients already branch on generically: `'cookie' | 'oauth-file'`. New providers
should reuse those kinds when possible so multi and the dashboard need no code change.

## Related projects

- [multi-provider-usage-extension](https://github.com/bubbabright/multi-provider-usage-extension) (thin multi client; requires this daemon)
- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension) (Claude standalone, own engine)
- [supergrok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension) (Grok standalone, own engine)
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension) (Ollama thin client; requires this daemon)
