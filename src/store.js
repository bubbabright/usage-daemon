// Per-provider append-only history. One JSON object per successful poll,
// mirrors the extensions' history.jsonl contract but namespaced by provider.
// ~/.local/state/usage-daemon/<provider>/history.jsonl, trimmed to ~20k lines.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LINES = 20000;

function stateDir(provider) {
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'usage-daemon', provider);
}

function historyPath(provider) {
  return path.join(stateDir(provider), 'history.jsonl');
}

// Flatten a snapshot's windows into a compact history row.
export function historyRow(snapshot) {
  const row = { t: snapshot.t, tier: snapshot.tier };
  for (const w of snapshot.windows) {
    if (w.pct != null) row[w.id] = w.pct;
  }
  return row;
}

export async function append(provider, snapshot) {
  const dir = stateDir(provider);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify(historyRow(snapshot)) + '\n';
  await fs.appendFile(historyPath(provider), line, 'utf8');
  await trim(provider).catch(() => {});
}

async function trim(provider) {
  const p = historyPath(provider);
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= MAX_LINES) return;
  const kept = lines.slice(lines.length - MAX_LINES);
  await fs.writeFile(p, kept.join('\n') + '\n', 'utf8');
}

export async function read(provider) {
  let text;
  try {
    text = await fs.readFile(historyPath(provider), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
