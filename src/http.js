// HTTP surface (localhost only). Routes:
//   GET  /usage/providers            -> configured providers + status
//   GET  /usage/:provider/config     -> provider metadata (windows, tiers, auth kind)
//   GET  /usage/:provider/icon       -> icon file (?variant=dark etc, falls back to default)
//   GET  /usage/:provider/icons      -> list available icon variants
//   GET  /usage/:provider/current    -> A2 snapshot
//   GET  /usage/:provider/history    -> history rows
//   POST /usage/:provider/refresh    -> force an immediate poll, return snapshot
//   POST /usage/:provider/cookie     -> store session cookie (daemon owns it), re-poll
//   GET  /                           -> multi-provider dashboard (HANDOFF-17)
//   GET  /?provider=ollama           -> self-contained HTML report

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportHtml } from './report.js';
import { dashboardHtml } from './dashboard.js';

const MAX_BODY = 64 * 1024; // cookies are small; cap to avoid unbounded reads

// Icons live alongside each provider plugin as providers/icons/<id>.<ext>, or
// providers/icons/<id>-<variant>.<ext> for optional variants (e.g. "dark",
// "light") — a convention, not a registry, so shipping an icon costs zero
// code (HANDOFF-14 zero-touch rule applies to daemon plugins too, not just
// the ext side).
const ICONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers', 'icons');
const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' };

// Find the icon file for a provider + optional variant, falling back to the
// bare <id>.<ext> ("default") if the requested variant doesn't exist.
async function findIconFile(provider, variant) {
  const stems = variant ? [`${provider}-${variant}`, provider] : [provider];
  for (const stem of stems) {
    for (const [ext, type] of Object.entries(ICON_TYPES)) {
      try {
        const data = await fs.readFile(path.join(ICONS_DIR, `${stem}${ext}`));
        return { data, type };
      } catch { /* try next extension/stem */ }
    }
  }
  return null;
}

// List icon variants available for a provider, derived purely from filenames
// already on disk — "default" for the bare <id>.<ext>, else the <variant>
// suffix. No registry to keep in sync.
async function listIconVariants(provider) {
  let entries;
  try {
    entries = await fs.readdir(ICONS_DIR);
  } catch {
    return [];
  }
  const exts = Object.keys(ICON_TYPES);
  const variants = [];
  for (const name of entries) {
    const ext = exts.find((e) => name.endsWith(e));
    if (!ext) continue;
    const stem = name.slice(0, -ext.length);
    if (stem === provider) variants.push('default');
    else if (stem.startsWith(`${provider}-`)) variants.push(stem.slice(provider.length + 1));
  }
  return variants;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

// Read a bounded request body. Accepts JSON {"cookie":"..."} or raw text/plain.
function readCookieBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try {
          resolve(String(JSON.parse(data).cookie ?? '').trim());
        } catch {
          reject(new Error('invalid JSON body'));
        }
      } else {
        resolve(data.trim());
      }
    });
    req.on('error', reject);
  });
}

export function createServer(runner) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['usage','ollama','current']
    const method = req.method;

    try {
      // GET /  -> dashboard; GET /?provider=…  -> per-provider report
      if (url.pathname === '/' && method === 'GET') {
        const provider = url.searchParams.get('provider');
        if (!provider) {
          const html = dashboardHtml();
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(html),
          });
          return res.end(html);
        }
        const entry = runner.providers.get(provider);
        if (!entry) return json(res, 404, { error: 'unknown provider', provider });
        const windows = entry.provider.config?.()?.windows ?? [];
        const html = reportHtml(provider, windows);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
        });
        return res.end(html);
      }

      if (parts[0] === 'usage') {
        // GET /usage/providers
        if (parts.length === 2 && parts[1] === 'providers' && method === 'GET') {
          return json(res, 200, runner.list());
        }
        const provider = parts[1];
        const action = parts[2];

        if (provider && action === 'config' && method === 'GET') {
          const entry = runner.providers.get(provider);
          if (!entry) return json(res, 404, { error: 'unknown provider', provider });
          const c = entry.provider.config?.();
          return json(res, 200, c ?? { error: 'no config' });
        }
        if (provider && action === 'icon' && method === 'GET') {
          const found = await findIconFile(provider, url.searchParams.get('variant'));
          if (!found) return json(res, 404, { error: 'no icon', provider });
          res.writeHead(200, { 'content-type': found.type, 'content-length': found.data.length });
          return res.end(found.data);
        }
        if (provider && action === 'icons' && method === 'GET') {
          return json(res, 200, await listIconVariants(provider));
        }
        if (provider && action === 'current' && method === 'GET') {
          const snap = runner.getCurrent(provider);
          if (!snap) return json(res, 404, { error: 'no snapshot yet', provider });
          return json(res, 200, snap);
        }
        if (provider && action === 'history' && method === 'GET') {
          return json(res, 200, await runner.getHistory(provider));
        }
        if (provider && action === 'refresh' && method === 'POST') {
          const snap = await runner.poll(provider);
          return json(res, 200, snap);
        }
        if (provider && action === 'cookie' && method === 'POST') {
          const cookie = await readCookieBody(req);
          if (!cookie) return json(res, 400, { error: 'empty cookie' });
          const snap = await runner.setCookie(provider, cookie);
          // never echo the cookie back; return the resulting snapshot only
          return json(res, 200, snap);
        }
      }

      return json(res, 404, { error: 'not found', path: url.pathname });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });
}
