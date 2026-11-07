// Pure scheduling math for batch conversions: CPU-aware capacity, task
// weights, and per-process thread counts. No I/O here so the tests are direct.
export type JobWeight = number;

export const WEIGHTS: Record<'video' | 'audio' | 'image' | 'copy' | 'hardware', JobWeight> = {
  video: 1,
  audio: 0.5,
  image: 0.5,
  copy: 0.25,
  hardware: 0.5,
};

// Capacity in "video-equivalent" units. Conservative: one job until the first
// one-second sample proves the machine is idle.
export function capacityFor(usage: number, cpus: number): number {
  const cap = Math.min(4, Math.max(1, Math.floor(cpus) - 1));
  const value = Number.isFinite(usage) ? Math.max(0, Math.min(1, usage)) : 1;
  if (value > 0.6) return 1;
  if (value > 0.35) return Math.min(2, cap);
  return cap;
}

// 0 means "let ffmpeg use its own default" (all cores).
export function threadsFor(capacity: number, weight: number, cpus: number): number {
  if (capacity <= 1) return 0;
  const share = Math.max(0.25, Math.min(1, weight));
  return Math.max(1, Math.min(cpus, Math.floor((cpus * share) / capacity)));
}

// One PTC evaluation has a hard wall-clock cap (10 minutes by default), so a
// big batch is split into several evaluations: each group gets its own timeout,
// and the whole batch can run longer than one evaluation may.
export const PTC_GROUP_MAX_FILES = 40;

export interface PtcGroupLimits {
  defaultMs: number;
  maxMs: number;
  maxFiles?: number;
}

export interface PtcGroup<T> {
  items: T[];
  timeoutMs: number;
}

// Conservative estimate of one group's encode time: a fixed start-up, twice the
// media duration, and five seconds per file for planning/IO. Clamped into the
// runtime's [defaultMs, maxMs] window.
export function planPtcGroups<T extends { duration: number }>(files: T[], limits: PtcGroupLimits): PtcGroup<T>[] {
  const maxFiles = Math.max(1, limits.maxFiles ?? PTC_GROUP_MAX_FILES);
  const clamp = (ms: number) => Math.min(limits.maxMs, Math.max(limits.defaultMs, ms));
  const estimate = (items: T[]) =>
    Math.max(0, 60_000 + items.reduce((sum, file) => sum + Math.max(0, file.duration) * 2000, 0) + items.length * 5000);
  const groups: PtcGroup<T>[] = [];
  let current: T[] = [];
  for (const file of files) {
    const next = [...current, file];
    // One file that cannot fit the cap still gets its own group: refusing it
    // here would only move the same failure into the result rows.
    if (current.length && (next.length > maxFiles || estimate(next) > limits.maxMs)) {
      groups.push({ items: current, timeoutMs: clamp(estimate(current)) });
      current = [file];
    } else {
      current = next;
    }
  }
  if (current.length) groups.push({ items: current, timeoutMs: clamp(estimate(current)) });
  return groups;
}
