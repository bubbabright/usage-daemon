// HTTP surface (localhost only). Routes:
//   GET  /usage/providers            -> configured providers + status
//   GET  /usage/:provider/current    -> A2 snapshot
//   GET  /usage/:provider/history    -> history rows
//   POST /usage/:provider/refresh    -> force an immediate poll, return snapshot
//   POST /usage/:provider/cookie     -> store session cookie (daemon owns it), re-poll
//   GET  /?provider=ollama           -> self-contained HTML report

import http from 'node:http';
import { reportHtml } from './report.js';

const MAX_BODY = 64 * 1024; // cookies are small; cap to avoid unbounded reads

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
      // GET /?provider=ollama  -> report
      if (url.pathname === '/' && method === 'GET') {
        const provider = url.searchParams.get('provider');
        if (!provider) return json(res, 400, { error: 'provider query required' });
        const html = reportHtml(provider);
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
