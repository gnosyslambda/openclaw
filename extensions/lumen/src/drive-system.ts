/**
 * Drive System — the internal motivation engine that replaces cron.
 *
 * Port of Python drive_system.py.
 * Drives accumulate over time; when any drive exceeds THRESHOLD the cognitive
 * loop wakes up. Drive interactions model homeostatic suppression (e.g. high
 * duty suppresses curiosity).
 */

import { DriveType, type DriveSnapshot } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Growth rate per hour for each drive. */
const GROWTH_RATES: Record<DriveType, number> = {
  [DriveType.DUTY]: 0.08,
  [DriveType.VIGILANCE]: 0.03,
  [DriveType.SOCIAL]: 0.04,
  [DriveType.CURIOSITY]: 3.0, // ~5분이면 0.25 도달 → probe 실행 가능
};

/**
 * Drive interactions: [source, target, suppressFactor].
 * When source is high, target's growth is suppressed.
 * target_growth *= (1 - suppressFactor * source_level)
 */
const DRIVE_INTERACTIONS: ReadonlyArray<[source: DriveType, target: DriveType, factor: number]> = [
  [DriveType.DUTY, DriveType.CURIOSITY, 0.6], // busy → less exploration
  [DriveType.VIGILANCE, DriveType.CURIOSITY, 0.4], // alert → less exploration
  [DriveType.DUTY, DriveType.SOCIAL, 0.3], // busy → slight report delay
];

/** A drive must reach this level to trigger a cognitive cycle. */
export const THRESHOLD = 0.6;

/** Max stimulation per drive per cycle — prevents action→event→drive→action loops. */
const MAX_STIMULATE_PER_CYCLE = 0.5;

/** Cap elapsed seconds to prevent drive saturation after long gateway downtime. */
const MAX_ELAPSED_SECONDS = 3600;

// ─── All drive types for iteration ──────────────────────────────────────────

const ALL_DRIVES: readonly DriveType[] = [
  DriveType.DUTY,
  DriveType.VIGILANCE,
  DriveType.SOCIAL,
  DriveType.CURIOSITY,
];

// ─── DriveSystem ─────────────────────────────────────────────────────────────

export class DriveSystem {
  private levels: Map<DriveType, number>;
  private cycleIncreases: Map<DriveType, number>;

  constructor(initial?: DriveSnapshot) {
    this.levels = new Map<DriveType, number>();
    this.cycleIncreases = new Map<DriveType, number>();
    for (const d of ALL_DRIVES) {
      this.levels.set(d, initial?.[d] ?? 0.0);
      this.cycleIncreases.set(d, 0.0);
    }
  }

  /** Get the current level of a single drive. */
  get(drive: DriveType): number {
    return this.levels.get(drive) ?? 0.0;
  }

  /** Highest drive level across all drives. */
  maxLevel(): number {
    let max = 0;
    for (const v of this.levels.values()) {
      if (v > max) max = v;
    }
    return max;
  }

  /**
   * Advance drives by elapsed time (natural growth).
   * Elapsed is capped at MAX_ELAPSED_SECONDS to prevent saturation after
   * long gateway downtime.
   */
  tick(elapsedSeconds: number): void {
    const capped = Math.min(elapsedSeconds, MAX_ELAPSED_SECONDS);
    const elapsedHours = capped / 3600.0;

    for (const drive of ALL_DRIVES) {
      const baseRate = GROWTH_RATES[drive];

      // Apply suppression from other drives.
      let effectiveRate = baseRate;
      for (const [source, target, factor] of DRIVE_INTERACTIONS) {
        if (target === drive) {
          effectiveRate *= 1.0 - factor * (this.levels.get(source) ?? 0.0);
        }
      }
      effectiveRate = Math.max(0.0, effectiveRate);

      const current = this.levels.get(drive) ?? 0.0;
      this.levels.set(drive, Math.min(1.0, current + effectiveRate * elapsedHours));
    }
  }

  /** Reset per-cycle stimulation tracking. Call at the start of each cognitive cycle. */
  beginCycle(): void {
    for (const d of ALL_DRIVES) {
      this.cycleIncreases.set(d, 0.0);
    }
  }

  /** Increase a drive by a given amount, subject to per-cycle cap. */
  stimulate(drive: DriveType, amount: number): void {
    const used = this.cycleIncreases.get(drive) ?? 0.0;
    const remaining = MAX_STIMULATE_PER_CYCLE - used;
    const capped = Math.min(amount, Math.max(0.0, remaining));
    if (capped <= 0) return;

    this.cycleIncreases.set(drive, used + capped);
    const current = this.levels.get(drive) ?? 0.0;
    this.levels.set(drive, Math.min(1.0, current + capped));
  }

  /** Decrease a drive (e.g. after completing a task satisfies duty). */
  satisfy(drive: DriveType, amount: number): void {
    const current = this.levels.get(drive) ?? 0.0;
    this.levels.set(drive, Math.max(0.0, current - amount));
  }

  /** Apply a map of drive impacts (e.g. from an event). */
  applyImpacts(impacts: Partial<Record<DriveType, number>>): void {
    for (const [drive, amount] of Object.entries(impacts) as Array<[DriveType, number]>) {
      this.stimulate(drive, amount);
    }
  }

  /** True if any drive is at or above threshold. */
  anyTriggered(): boolean {
    for (const v of this.levels.values()) {
      if (v >= THRESHOLD) return true;
    }
    return false;
  }

  /** List of drives currently at or above threshold. */
  triggeredDrives(): DriveType[] {
    const result: DriveType[] = [];
    for (const [d, v] of this.levels) {
      if (v >= THRESHOLD) result.push(d);
    }
    return result;
  }

  /**
   * Adaptive delay in seconds — higher drive levels yield shorter delays.
   * Used by the cognitive loop to decide how long to sleep.
   */
  adaptiveDelay(): number {
    const level = this.maxLevel();
    if (level >= 0.8) return 1.0;
    if (level >= 0.5) return 10.0;
    if (level >= 0.3) return 30.0;
    if (level >= 0.1) return 120.0;
    return 300.0;
  }

  /** Return a plain-object snapshot of all drive levels (rounded to 4 decimals). */
  snapshot(): DriveSnapshot {
    const snap = {} as DriveSnapshot;
    for (const d of ALL_DRIVES) {
      snap[d] = Math.round((this.levels.get(d) ?? 0.0) * 10000) / 10000;
    }
    return snap;
  }

  /** Restore drive levels from a previously saved snapshot. */
  restore(snap: DriveSnapshot): void {
    for (const d of ALL_DRIVES) {
      if (snap[d] !== undefined) {
        this.levels.set(d, snap[d]);
      }
    }
  }
}
