#!/usr/bin/env node
// usage-daemon entry point. Loads config, registers compiled-in provider plugins,
// wires the runner, and starts the localhost HTTP surface on 127.0.0.1:<port>.

// IPv4-only outbound (must be first — before any provider fetch). Lab has no
// working IPv6; dual-stack undici fetch times out on AAAA-bearing hosts.
import './ipv4.js';

import { loadConfig, DEFAULT_PORT, expandHome } from './config.js';
import * as registry from './registry.js';
import { Runner } from './runner.js';
import { createServer } from './http.js';

// --- register providers (compiled-in) ---
import { createProvider as createOllama } from './providers/ollama.js';
registry.register('ollama', createOllama);
import { createProvider as createClaude } from './providers/claude.js';
registry.register('claude', createClaude);
import { createProvider as createGrok } from './providers/grok.js';
registry.register('grok', createGrok);
// mistral registered but off by default (config enabled=false); enable in
// config.toml when testing. Does not load unless enabled.
import { createProvider as createMistral } from './providers/mistral.js';
registry.register('mistral', createMistral);
import { createProvider as createOpencodeGo } from './providers/opencode-go.js';
registry.register('opencode-go', createOpencodeGo);

async function main() {
  const cfg = await loadConfig();
  const runner = new Runner();

  for (const [name, pcfg] of Object.entries(cfg.providers)) {
    if (pcfg.enabled === false) continue;
    if (!registry.has(name)) {
      console.error(`usage-daemon: config names unknown provider '${name}', skipping`);
      continue;
    }
    const provider = registry.create(name);
    provider.configure?.(pcfg);
    runner.add(provider, { cookieFile: expandHome(pcfg.cookie_file) });
    console.error(`usage-daemon: provider '${name}' enabled (interval ${provider.intervalSeconds?.() ?? 300}s)`);
  }

  runner.start();

  const port = cfg.port ?? DEFAULT_PORT;
  const server = createServer(runner);
  server.listen(port, '127.0.0.1', () => {
    console.error(`usage-daemon: listening on http://127.0.0.1:${port}`);
  });

  const shutdown = () => {
    console.error('usage-daemon: shutting down');
    runner.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('usage-daemon: fatal', err);
  process.exit(1);
});
