/**
 * Cost Controller — LLM call budget management.
 *
 * Port of Python cost_controller.py.
 * Tracks LLM call costs, enforces daily budget and L3 call limits,
 * and provides automatic level downgrade when budget is exhausted.
 */

import type { CostRecord, CostSummary } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Fallback cost per call when token counts are unavailable. */
const COST_PER_CALL: Record<string, number> = {
  L1: 0.0,
  L2: 0.003,
  L3: 0.015,
};

/** Token-based pricing ($/1M tokens, 2026-03). */
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  L1: { input: 0.0, output: 0.0 },
  L2: { input: 3.0, output: 15.0 }, // Sonnet
  L3: { input: 15.0, output: 75.0 }, // Opus
};

const DEFAULT_DAILY_BUDGET = 1.0; // $1/day
const DEFAULT_L3_DAILY_LIMIT = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Epoch ms of today's midnight (local time). */
function todayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Compute cost from token counts, falling back to fixed estimate. */
function computeCost(
  level: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (inputTokens > 0 || outputTokens > 0) {
    const prices = TOKEN_PRICES[level] ?? TOKEN_PRICES.L1;
    return (
      (inputTokens * prices.input) / 1_000_000 +
      (outputTokens * prices.output) / 1_000_000
    );
  }
  return COST_PER_CALL[level] ?? 0.0;
}

// ─── CostController ─────────────────────────────────────────────────────────

export class CostController {
  private dailyBudget: number;
  private l3DailyLimit: number;
  private records: CostRecord[];
  private dayStartMs: number;

  constructor(
    dailyBudget: number = DEFAULT_DAILY_BUDGET,
    l3DailyLimit: number = DEFAULT_L3_DAILY_LIMIT,
  ) {
    this.dailyBudget = dailyBudget;
    this.l3DailyLimit = l3DailyLimit;
    this.records = [];
    this.dayStartMs = todayStartMs();
  }

  /** Record an LLM call. Token-based cost if available, else fixed estimate. */
  recordCall(
    level: string,
    inputTokens: number = 0,
    outputTokens: number = 0,
  ): void {
    const now = Date.now();
    this.maybeResetDay(now);

    const cost = computeCost(level, inputTokens, outputTokens);
    this.records.push({
      timestamp: now,
      level,
      estimatedCost: cost,
      inputTokens,
      outputTokens,
    });
  }

  /** Check if a call at the given level is within budget. L1 is always allowed. */
  canCall(level: string): boolean {
    if (level === "L1") return true;

    this.maybeResetDay(Date.now());
    const today = this.todayRecords();
    const todayCost = today.reduce((sum, r) => sum + r.estimatedCost, 0);
    const proposedCost = COST_PER_CALL[level] ?? 0.0;

    if (todayCost + proposedCost > this.dailyBudget) {
      return false;
    }

    if (level === "L3") {
      const l3Count = today.filter((r) => r.level === "L3").length;
      if (l3Count >= this.l3DailyLimit) {
        return false;
      }
    }

    return true;
  }

  /** Downgrade level if budget is exhausted: L3 → L2 → L1. */
  downgradeLevel(requested: string): string {
    if (this.canCall(requested)) return requested;

    if (requested === "L3") {
      if (this.canCall("L2")) return "L2";
      return "L1";
    }
    if (requested === "L2") {
      return "L1";
    }
    return "L1";
  }

  /** Summary of today's cost and call distribution. */
  getSummary(): CostSummary {
    const today = this.todayRecords();
    const totalCost = today.reduce((sum, r) => sum + r.estimatedCost, 0);
    const l1Count = today.filter((r) => r.level === "L1").length;
    const l2Count = today.filter((r) => r.level === "L2").length;
    const l3Count = today.filter((r) => r.level === "L3").length;
    const count = l1Count + l2Count + l3Count || 1;

    return {
      totalCost,
      l1Count,
      l2Count,
      l3Count,
      l1Ratio: l1Count / count,
      l2Ratio: l2Count / count,
      l3Ratio: l3Count / count,
      budgetRemaining: Math.max(0.0, this.dailyBudget - totalCost),
      budgetUsedRatio:
        this.dailyBudget > 0 ? totalCost / this.dailyBudget : 1.0,
    };
  }

  /** Get all cost records (for persistence). */
  getRecords(): CostRecord[] {
    return [...this.records];
  }

  /** Get the day-start timestamp in ms (for persistence). */
  getDayStartMs(): number {
    return this.dayStartMs;
  }

  /** Restore state from persisted data. */
  restore(
    records: CostRecord[],
    dayStartMs: number,
    dailyBudget?: number,
    l3DailyLimit?: number,
  ): void {
    this.records = [...records];
    this.dayStartMs = dayStartMs;
    if (dailyBudget !== undefined) this.dailyBudget = dailyBudget;
    if (l3DailyLimit !== undefined) this.l3DailyLimit = l3DailyLimit;
    this.maybeResetDay(Date.now());
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** Reset daily counters if midnight has passed. */
  private maybeResetDay(nowMs: number): void {
    if (nowMs - this.dayStartMs > 86_400_000) {
      this.dayStartMs = todayStartMs();
    }
  }

  /** Filter records to today only. */
  private todayRecords(): CostRecord[] {
    return this.records.filter((r) => r.timestamp >= this.dayStartMs);
  }
}
