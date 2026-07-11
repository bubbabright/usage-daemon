#!/usr/bin/env node
// usage-daemon entry point. Loads config, registers compiled-in provider plugins,
// wires the runner, and starts the localhost HTTP surface on 127.0.0.1:<port>.

import { loadConfig, DEFAULT_PORT } from './config.js';
import * as registry from './registry.js';
import { Runner } from './runner.js';
import { createServer } from './http.js';

// --- register providers (compiled-in) ---
import { createProvider as createOllama } from './providers/ollama.js';
registry.register('ollama', createOllama);
// future: registry.register('claude', createClaude); register('grok', ...)

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
    runner.add(provider);
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
