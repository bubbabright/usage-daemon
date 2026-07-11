// Config loader for ~/.config/usage-daemon/config.toml.
//
// Zero-dep: a minimal TOML reader covering exactly the documented shape —
// [section.subsection] tables, key = "string" | int | true/false, # comments.
// Not a full TOML implementation; if config grows, swap for a real parser.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8787;

function configPath() {
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'usage-daemon', 'config.toml');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  const m = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
  if (m) return m[1];
  return v;
}

// Minimal TOML -> nested object.
export function parseToml(text) {
  const root = {};
  let table = root;
  for (let line of text.split('\n')) {
    line = line.replace(/(^|\s)#.*$/, '').trim(); // strip comments
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      table = root;
      for (const key of sec[1].split('.').map((s) => s.trim())) {
        table[key] = table[key] || {};
        table = table[key];
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (kv) table[kv[1]] = parseValue(kv[2]);
  }
  return root;
}

const DEFAULTS = {
  port: DEFAULT_PORT,
  providers: {
    ollama: { enabled: true, interval_seconds: 300 },
  },
};

// Load config, resolving cookie_file -> cookie. Missing file = defaults.
export async function loadConfig() {
  let parsed = {};
  try {
    parsed = parseToml(await fs.readFile(configPath(), 'utf8'));
  } catch {
    parsed = {};
  }
  const cfg = {
    port: parsed.port ?? DEFAULTS.port,
    providers: { ...DEFAULTS.providers, ...(parsed.providers || {}) },
  };

  // resolve each provider's cookie from cookie_file if not inline.
  for (const [name, pcfg] of Object.entries(cfg.providers)) {
    if (!pcfg.cookie && pcfg.cookie_file) {
      try {
        pcfg.cookie = (
          await fs.readFile(expandHome(pcfg.cookie_file), 'utf8')
        ).trim();
      } catch {
        // leave unset -> provider reports auth_expired until cookie exists.
      }
    }
    cfg.providers[name] = pcfg;
  }
  return cfg;
}
