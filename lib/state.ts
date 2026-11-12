// Cross-restart state (R5): what the Host rebuilds after a DSH restart, and
// the pure decisions behind the rebuild. The caller does every file system
// touch — this module only shapes and validates the data, so the tests are
// direct. Corrupt or foreign state must never block startup: parse failures
// degrade to null and the caller starts empty.

import type { RunInfo, Upload } from '../index.js';
import type { PtcRates } from './schedule.js';

export interface PersistedUpload extends Upload {
  // Present on rows the uploader probed itself; rows without it always reprobe.
  mTimeMs?: number;
}

export interface PersistedState {
  schemaVersion: 1;
  uploads: PersistedUpload[];
  // Only running runs are worth rebuilding; finished ones live 30 more minutes
  // in memory and the summary banner (R1) already covers their window.
  runs: RunInfo[];
  latestRun: string;
  ptcRates: PtcRates;
  // Outputs a job had not finished when the host died: swept on restore so a
  // half-written file never survives a restart.
  interrupted: { out: string }[];
}

export function serializeState(state: Omit<PersistedState, 'schemaVersion'> & { schemaVersion: 1 }): string {
  return JSON.stringify(state);
}

// Null on anything that is not a v1 state document: garbage, a truncated write,
// or a newer schema the running build must not half-understand.
export function parseState(text: string): PersistedState | null {
  try {
    const raw = JSON.parse(text) as Partial<PersistedState> | null;
    if (!raw || raw.schemaVersion !== 1) return null;
    if (!Array.isArray(raw.uploads) || !Array.isArray(raw.runs) || !Array.isArray(raw.interrupted)) return null;
    if (typeof raw.latestRun !== 'string' || !raw.ptcRates || typeof raw.ptcRates !== 'object') return null;
    return raw as PersistedState;
  } catch {
    return null;
  }
}

// What to do with one stored upload when the host comes back:
// - drop: the source is gone (an owned tmp copy the system reclaimed, a
//   registered file the user deleted) — the row cannot serve conversions.
// - reprobe: size or mtime moved — the file changed on disk, so the stored
//   metadata (duration, tracks, tags) cannot be trusted anymore.
// - adopt: untouched — reuse the stored probe, the whole point of persisting.
export function restoreDecision(
  stored: { size: number; mTimeMs?: number },
  stat: { size: number; mtimeMs: number } | null,
): 'adopt' | 'reprobe' | 'drop' {
  if (!stat) return 'drop';
  if (stored.mTimeMs === undefined || stat.mtimeMs !== stored.mTimeMs || stat.size !== stored.size) return 'reprobe';
  return 'adopt';
}
