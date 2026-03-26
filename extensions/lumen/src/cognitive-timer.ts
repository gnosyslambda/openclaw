/**
 * CognitiveTimer — Adaptive heartbeat using recursive setTimeout.
 *
 * Drives the Lumen cognitive loop with an adaptive delay that speeds up
 * when drives are high and slows down when the agent is idle.
 */

import type { ProbeRunner, ProbeResult } from "./probe-runner.js";

// ─── Dependency Interfaces ──────────────────────────────────────────────────
// These describe the minimal surface CognitiveTimer needs from its collaborators.

export interface DriveSystem {
  /** Advance drive levels by `elapsedSec` seconds (capped at 3600). */
  tick(elapsedSec: number): void;
  /** Current drive level (0–1). */
  get(drive: "duty" | "vigilance" | "social" | "curiosity"): number;
  /** Adaptive delay in seconds based on current drive levels. */
  adaptiveDelay(): number;
}

export interface CostController {
  /** Whether the daily budget still has room for an L2 call. */
  canSpend(level: "L1" | "L2" | "L3"): boolean;
}

export interface StateStore {
  /** Persist current state to disk/db. */
  save(): void | Promise<void>;
}

// ─── Rate Limiter ───────────────────────────────────────────────────────────

interface RateLimitState {
  lastProactiveAt: number;
  dailyProactiveCount: number;
  currentBackoffMs: number;
  /** Epoch ms when the daily counter was last reset. */
  dayStartMs: number;
}

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DAILY_CAP = 20;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_BACKOFF_MS = MIN_INTERVAL_MS;
const HIGH_SEVERITY_THRESHOLD = 0.6;

// ─── CognitiveTimer ─────────────────────────────────────────────────────────

export interface CognitiveTimerParams {
  drives: DriveSystem;
  probes: ProbeRunner;
  costs: CostController;
  stateStore: StateStore;
  onProactiveMessage?: (message: string) => Promise<void>;
}

export class CognitiveTimer {
  private drives: DriveSystem;
  private probes: ProbeRunner;
  private costs: CostController;
  private stateStore: StateStore;
  private onProactiveMessage?: (message: string) => Promise<void>;

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastTickMs: number = Date.now();
  private running = false;

  private rateLimit: RateLimitState = {
    lastProactiveAt: 0,
    dailyProactiveCount: 0,
    currentBackoffMs: DEFAULT_BACKOFF_MS,
    dayStartMs: Date.now(),
  };

  constructor(params: CognitiveTimerParams) {
    this.drives = params.drives;
    this.probes = params.probes;
    this.costs = params.costs;
    this.stateStore = params.stateStore;
    this.onProactiveMessage = params.onProactiveMessage;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickMs = Date.now();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  // ── Core Loop ───────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();
    const elapsedMs = now - this.lastTickMs;
    const elapsedSec = Math.min(elapsedMs / 1000, 3600);
    this.lastTickMs = now;

    // 1. Advance drives
    this.drives.tick(elapsedSec);

    // 2. Curiosity-driven probing (only when idle enough)
    const curiosity = this.drives.get("curiosity");
    const duty = this.drives.get("duty");
    const vigilance = this.drives.get("vigilance");

    if (curiosity > 0.4 && duty < 0.5 && vigilance < 0.5) {
      const results = await this.probes.runDueProbes();

      // 3. Check for high-severity results
      const highSeverity = results.filter((r) => r.severity >= HIGH_SEVERITY_THRESHOLD);

      if (highSeverity.length > 0 && this.onProactiveMessage) {
        await this.maybeProactiveMessage(highSeverity);
      }
    }

    // 4. Persist state
    await this.stateStore.save();

    // 5. Schedule next tick
    if (this.running) {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    const delaySec = this.drives.adaptiveDelay();
    const delayMs = delaySec * 1000;

    this.timerId = setTimeout(() => {
      this.tick().catch((err) => {
        // Log but don't crash — schedule next tick regardless
        console.error("[CognitiveTimer] tick error:", err);
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, delayMs);
  }

  // ── Rate-Limited Proactive Messaging ────────────────────────────────────

  private async maybeProactiveMessage(results: ProbeResult[]): Promise<void> {
    if (!this.onProactiveMessage) return;

    const now = Date.now();

    // Reset daily counter if a new day
    if (now - this.rateLimit.dayStartMs >= 24 * 60 * 60 * 1000) {
      this.rateLimit.dailyProactiveCount = 0;
      this.rateLimit.dayStartMs = now;
      this.rateLimit.currentBackoffMs = DEFAULT_BACKOFF_MS;
    }

    // Check daily cap
    if (this.rateLimit.dailyProactiveCount >= DAILY_CAP) return;

    // Check minimum interval with backoff
    const effectiveInterval = Math.max(MIN_INTERVAL_MS, this.rateLimit.currentBackoffMs);
    if (now - this.rateLimit.lastProactiveAt < effectiveInterval) return;

    // Build message from high-severity results
    const lines = results.map(
      (r) => `- **${r.name}** (severity ${r.severity.toFixed(2)}): ${r.observation}`,
    );
    const message = [`[Lumen Probe Alert] ${results.length} issue(s) detected:`, ...lines].join(
      "\n",
    );

    try {
      await this.onProactiveMessage(message);
      this.rateLimit.lastProactiveAt = now;
      this.rateLimit.dailyProactiveCount++;
      // Increase backoff (will be reset when user responds)
      this.rateLimit.currentBackoffMs = Math.min(
        MAX_BACKOFF_MS,
        this.rateLimit.currentBackoffMs * BACKOFF_MULTIPLIER,
      );
    } catch {
      // Silently ignore send failures — will retry next tick
    }
  }

  /**
   * Call this when the user sends a message to reset backoff.
   * Indicates the user is active and proactive messages are welcome.
   */
  resetBackoff(): void {
    this.rateLimit.currentBackoffMs = DEFAULT_BACKOFF_MS;
  }
}
