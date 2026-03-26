/**
 * Lumen OpenClaw Extension — Entry Point
 *
 * Integrates the Lumen cognitive engine into OpenClaw as a plugin,
 * providing adaptive urgency, drive-based model selection, and
 * proactive agent behavior.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildLumenContext, evaluateThinkLevel } from "./prompt-injector.js";
import type { DriveState, DriveSystem, ProbeResult, CostSummary } from "./prompt-injector.js";

// ─── Drive Types ────────────────────────────────────────────────────

enum DriveType {
  DUTY = "duty",
  VIGILANCE = "vigilance",
  SOCIAL = "social",
  CURIOSITY = "curiosity",
}

// ─── Drive System Implementation ────────────────────────────────────

class DriveSystemImpl implements DriveSystem {
  private state: DriveState = {
    duty: 0,
    vigilance: 0,
    social: 0,
    curiosity: 0,
  };

  private cycleActive = false;
  private stimulatedThisCycle = 0;
  private static readonly MAX_STIMULATE_PER_CYCLE = 0.5;

  getState(): DriveState {
    return { ...this.state };
  }

  beginCycle(): void {
    this.cycleActive = true;
    this.stimulatedThisCycle = 0;
  }

  stimulate(drive: DriveType, amount: number): void {
    const remaining = DriveSystemImpl.MAX_STIMULATE_PER_CYCLE - this.stimulatedThisCycle;
    const capped = Math.min(amount, remaining);
    if (capped <= 0) return;

    this.state[drive] = Math.min(1, this.state[drive] + capped);
    this.stimulatedThisCycle += capped;
    this.applyInteractions();
  }

  satisfy(drive: DriveType, amount: number): void {
    this.state[drive] = Math.max(0, this.state[drive] - amount);
  }

  restore(saved: DriveState): void {
    this.state = { ...saved };
  }

  /** Drive interactions: duty/vigilance suppress curiosity, duty suppresses social. */
  private applyInteractions(): void {
    if (this.state.duty > 0.5) {
      this.state.curiosity *= 1 - 0.6 * (this.state.duty - 0.5) * 2;
      this.state.social *= 1 - 0.3 * (this.state.duty - 0.5) * 2;
    }
    if (this.state.vigilance > 0.5) {
      this.state.curiosity *= 1 - 0.4 * (this.state.vigilance - 0.5) * 2;
    }
  }
}

// ─── Probe Runner ───────────────────────────────────────────────────

class ProbeRunner {
  pendingResults: ProbeResult[] = [];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async runAll(): Promise<ProbeResult[]> {
    // Placeholder — real probes would inspect the filesystem, git state, etc.
    this.pendingResults = [];
    return this.pendingResults;
  }
}

// ─── Cost Controller ────────────────────────────────────────────────

class CostController {
  private todayUsd = 0;
  private dailyBudgetUsd = 1.0;
  private l2Calls = 0;
  private l3Calls = 0;
  private maxL3PerDay = 10;

  getSummary(): CostSummary {
    return {
      todayUsd: this.todayUsd,
      dailyBudgetUsd: this.dailyBudgetUsd,
      l2Calls: this.l2Calls,
      l3Calls: this.l3Calls,
    };
  }

  recordCall(level: "L2" | "L3", inputTokens: number, outputTokens: number): void {
    const cost =
      level === "L3"
        ? inputTokens * 0.000015 + outputTokens * 0.000075
        : inputTokens * 0.000003 + outputTokens * 0.000015;

    this.todayUsd += cost;
    if (level === "L3") this.l3Calls++;
    else this.l2Calls++;
  }

  /** Downgrade L3 to L2 if budget or daily L3 cap exceeded. */
  downgradeLevel(requested: "L2" | "L3"): "L2" | "L3" {
    if (requested === "L3") {
      if (this.todayUsd >= this.dailyBudgetUsd * 0.8) return "L2";
      if (this.l3Calls >= this.maxL3PerDay) return "L2";
    }
    return requested;
  }

  restore(saved: { todayUsd: number; l2Calls: number; l3Calls: number }): void {
    this.todayUsd = saved.todayUsd;
    this.l2Calls = saved.l2Calls;
    this.l3Calls = saved.l3Calls;
  }
}

// ─── State Store (Disk Persistence) ─────────────────────────────────

interface SavedState {
  drives: DriveState;
  costs: { todayUsd: number; l2Calls: number; l3Calls: number };
  savedAt: string;
}

class StateStore {
  private path: string;

  constructor(path = ".lumen-state.json") {
    this.path = path;
  }

  load(): SavedState | null {
    try {
      const fs = require("fs");
      const raw = fs.readFileSync(this.path, "utf-8");
      return JSON.parse(raw) as SavedState;
    } catch {
      return null;
    }
  }

  save(state: SavedState): void {
    try {
      const fs = require("fs");
      fs.writeFileSync(this.path, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Silently fail — state persistence is best-effort
    }
  }
}

// ─── Cognitive Timer ────────────────────────────────────────────────

interface CognitiveTimerConfig {
  drives: DriveSystemImpl;
  probes: ProbeRunner;
  costs: CostController;
  stateStore: StateStore;
  onProactiveMessage: (message: string) => Promise<void>;
}

class CognitiveTimer {
  private config: CognitiveTimerConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: CognitiveTimerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const state = this.config.drives.getState();
    const maxDrive = Math.max(state.duty, state.vigilance, state.social, state.curiosity);

    // Run probes when curiosity is the dominant drive
    if (state.curiosity >= 0.6 && state.curiosity >= maxDrive) {
      await this.config.probes.runAll();
    }

    // Adaptive delay based on drive pressure
    const delayMs = this.computeDelay(maxDrive);
    this.intervalId = setTimeout(() => this.tick(), delayMs);
  }

  private computeDelay(maxDrive: number): number {
    if (maxDrive >= 0.8) return 1_000;
    if (maxDrive >= 0.5) return 10_000;
    if (maxDrive >= 0.3) return 30_000;
    if (maxDrive >= 0.1) return 120_000;
    return 300_000;
  }
}

// ─── Plugin Entry ───────────────────────────────────────────────────

export default definePluginEntry({
  id: "lumen",
  name: "Lumen Cognitive Engine",
  description: "Adaptive urgency and proactive agent behavior",

  register(api) {
    let drives: DriveSystemImpl;
    let probes: ProbeRunner;
    let costs: CostController;
    let store: StateStore;
    let timer: CognitiveTimer;
    let lastChatId: string | null = null;

    // Hook 1: gateway_start — initialize all components
    api.on("gateway_start", async () => {
      drives = new DriveSystemImpl();
      probes = new ProbeRunner(".");
      costs = new CostController();
      store = new StateStore();

      // Restore persisted state
      const saved = store.load();
      if (saved) {
        drives.restore(saved.drives);
        costs.restore(saved.costs);
      }

      // Start the adaptive cognitive timer
      timer = new CognitiveTimer({
        drives,
        probes,
        costs,
        stateStore: store,
        onProactiveMessage: async (message: string) => {
          if (lastChatId) {
            await api.runtime.channel.telegram.sendMessageTelegram(
              lastChatId,
              message,
              {},
            );
            drives.satisfy(DriveType.SOCIAL, 0.5);
          }
        },
      });
      timer.start();

      api.logger.info("Lumen cognitive engine initialized");
    });

    // Hook 2: gateway_stop — persist state and stop timer
    api.on("gateway_stop", async () => {
      timer?.stop();
      store?.save({
        drives: drives.getState(),
        costs: {
          todayUsd: costs.getSummary().todayUsd,
          l2Calls: costs.getSummary().l2Calls,
          l3Calls: costs.getSummary().l3Calls,
        },
        savedAt: new Date().toISOString(),
      });
      api.logger.info("Lumen cognitive engine stopped, state persisted");
    });

    // Hook 3: before_prompt_build — inject cognitive state into system prompt
    api.on("before_prompt_build", async (_event, _ctx) => {
      const context = buildLumenContext({
        drives,
        probeResults: probes.pendingResults,
        costSummary: costs.getSummary(),
      });
      return { appendSystemContext: context };
    });

    // Hook 4: before_model_resolve — select model based on drive urgency
    api.on("before_model_resolve", async (_event, _ctx) => {
      const level = evaluateThinkLevel(drives);
      const actual = costs.downgradeLevel(level);
      if (actual === "L3") {
        return { model: "google/gemini-2.5-pro" };
      }
      return { model: "google/gemini-2.5-flash" };
    });

    // Hook 5: message_received — stimulate drives on user input
    api.on("message_received", async (event, _ctx) => {
      drives.beginCycle();
      drives.stimulate(DriveType.SOCIAL, 0.7);
      drives.stimulate(DriveType.DUTY, 0.5);

      // Cache chat ID for proactive messaging
      if (event.from) {
        lastChatId = event.from;
      }
    });

    // Hook 6: agent_end — satisfy drives after successful response
    api.on("agent_end", async (_event, _ctx) => {
      drives.satisfy(DriveType.SOCIAL, 0.5);
      drives.satisfy(DriveType.DUTY, 0.3);
    });

    // Hook 7: llm_output — track token usage for cost control
    api.on("llm_output", async (event, _ctx) => {
      const level = evaluateThinkLevel(drives);
      costs.recordCall(level, event.usage?.input ?? 0, event.usage?.output ?? 0);
    });
  },
});
