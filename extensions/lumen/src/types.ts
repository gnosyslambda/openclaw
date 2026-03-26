/**
 * Lumen type definitions — TypeScript equivalents of Python core types.
 */

// ─── Drive System ────────────────────────────────────────────────────────────

export enum DriveType {
  DUTY = "duty",
  VIGILANCE = "vigilance",
  SOCIAL = "social",
  CURIOSITY = "curiosity",
}

/** A snapshot of all drive levels at a point in time. */
export type DriveSnapshot = Record<DriveType, number>;

// ─── Thinker ─────────────────────────────────────────────────────────────────

/** Cognitive processing level. */
export type ThinkLevel = "SLEEP" | "L1" | "L2" | "L3";

// ─── Probe System ────────────────────────────────────────────────────────────

export interface ProbeResult {
  probeId: string;
  timestamp: number;
  value: number | string | boolean;
  metadata?: Record<string, unknown>;
}

// ─── Cost Controller ─────────────────────────────────────────────────────────

export interface CostRecord {
  timestamp: number;
  level: string; // "L1" | "L2" | "L3"
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary {
  totalCost: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  l1Ratio: number;
  l2Ratio: number;
  l3Ratio: number;
  budgetRemaining: number;
  budgetUsedRatio: number;
}

// ─── State Persistence ───────────────────────────────────────────────────────

export interface LumenState {
  /** Drive levels snapshot. */
  drives: DriveSnapshot;

  /** Cost records for the current day. */
  costRecords: CostRecord[];

  /** Epoch ms of the last tick() call. */
  lastTickMs: number;

  /** Epoch ms when the current cost day started. */
  costDayStartMs: number;

  /** Daily budget in dollars. */
  dailyBudget: number;

  /** L3 daily call limit. */
  l3DailyLimit: number;

  /** Last proactive message timestamp (epoch ms), if any. */
  lastProactiveMs?: number;

  /** Opaque metadata the extension may persist across restarts. */
  meta?: Record<string, unknown>;
}
