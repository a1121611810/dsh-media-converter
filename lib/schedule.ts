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

// Throughput seeds in "media seconds per wall second" (images are a fixed cost).
// They are only the first guess: every finished job blends its real rate in, so
// the estimates follow the machine, the codec and the copy/hardware paths.
export interface PtcRates {
  copy: number;
  hardware: number;
  video: number;
  audio: number;
  imageMs: number;
}

export const PTC_DEFAULT_RATES: PtcRates = { copy: 200, hardware: 15, video: 6, audio: 40, imageMs: 400 };

export interface PtcCostInput {
  duration: number;
  kind: 'video' | 'audio' | 'image' | 'text' | 'file';
  copy?: boolean;
  hardware?: boolean;
}

// How long one file is expected to take, from its own duration and the rates.
export function estimatePtcCost(file: PtcCostInput, rates: PtcRates = PTC_DEFAULT_RATES): number {
  const durationMs = Math.max(0, file.duration) * 1000;
  if (file.copy) return Math.max(150, durationMs / Math.max(1, rates.copy));
  if (file.kind === 'image' || file.kind === 'file' || file.kind === 'text' || durationMs === 0) {
    return Math.max(100, rates.imageMs);
  }
  const rate = file.hardware ? rates.hardware : file.kind === 'video' ? rates.video : rates.audio;
  return durationMs / Math.max(0.5, rate) + 400;
}

// Blend one finished job into a rate. Slow or very short jobs say little, so
// they are ignored; a single fast outlier cannot take the estimate over.
export function blendPtcRate(rate: number, mediaSeconds: number, wallMs: number): number {
  if (!(mediaSeconds > 0) || !(wallMs >= 300)) return rate;
  const observed = Math.max(0.2, mediaSeconds / (wallMs / 1000));
  return Math.max(0.5, rate * 0.6 + observed * 0.4);
}

export interface PtcGroupLimits {
  defaultMs: number;
  maxMs: number;
  maxFiles?: number;
}

export interface PtcGroup<T> {
  items: T[];
  timeoutMs: number;
  estimateMs: number;
}

// Fixed per-evaluation overhead plus a small per-file cost (handshake, IO).
const PTC_STARTUP_MS = 5_000;
const PTC_PER_FILE_MS = 1_500;

// Group by the real cost of the files: fill one evaluation until its estimate
// approaches the runtime cap, then start another. The timeout is the estimate
// with a margin, clamped into the runtime's [defaultMs, maxMs] window.
export function planPtcGroups<T extends { costMs: number }>(items: T[], limits: PtcGroupLimits): PtcGroup<T>[] {
  const maxFiles = Math.max(1, Math.round(limits.maxFiles ?? PTC_GROUP_MAX_FILES));
  const clamp = (ms: number) => Math.min(limits.maxMs, Math.max(limits.defaultMs, ms));
  const estimate = (group: T[]) =>
    PTC_STARTUP_MS + group.length * PTC_PER_FILE_MS + group.reduce((sum, item) => sum + Math.max(0, item.costMs), 0);
  const groups: PtcGroup<T>[] = [];
  let current: T[] = [];
  for (const item of items) {
    const next = [...current, item];
    // One file that cannot fit the cap still gets its own group: refusing it
    // here would only move the same failure into the result rows.
    if (current.length && (next.length > maxFiles || estimate(next) > limits.maxMs)) {
      const estimateMs = estimate(current);
      groups.push({ items: current, timeoutMs: clamp(Math.round(estimateMs * 1.4)), estimateMs });
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length) {
    const estimateMs = estimate(current);
    groups.push({ items: current, timeoutMs: clamp(Math.round(estimateMs * 1.4)), estimateMs });
  }
  return groups;
}
