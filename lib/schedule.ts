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
