/**
 * Lumen OpenClaw Extension — Entry Point
 *
 * Integrates the Lumen cognitive engine into OpenClaw as a plugin,
 * providing adaptive urgency, drive-based model selection, and
 * proactive agent behavior.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildLumenContext, evaluateThinkLevel } from "./src/prompt-injector.js";
import type { DriveState, DriveSystem, ProbeResult, CostSummary } from "./src/prompt-injector.js";

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

  /** 시간 경과에 따른 drive 자연 증가. */
  tick(elapsedSec: number): void {
    const capped = Math.min(elapsedSec, 3600);
    const hours = capped / 3600;
    const rates: Record<DriveType, number> = {
      [DriveType.DUTY]: 0.08,
      [DriveType.VIGILANCE]: 0.03,
      [DriveType.SOCIAL]: 0.04,
      [DriveType.CURIOSITY]: 1.8, // ~5분이면 0.15, ~20분이면 0.6
    };
    for (const key of Object.values(DriveType)) {
      let rate = rates[key];
      // Drive interactions: duty/vigilance suppress curiosity
      if (key === DriveType.CURIOSITY) {
        rate *= 1 - 0.6 * this.state[DriveType.DUTY];
        rate *= 1 - 0.4 * this.state[DriveType.VIGILANCE];
      }
      if (key === DriveType.SOCIAL) {
        rate *= 1 - 0.3 * this.state[DriveType.DUTY];
      }
      rate = Math.max(0, rate);
      this.state[key] = Math.min(1, this.state[key] + rate * hours);
    }
  }

  /** Drive 수준에 따른 적응적 딜레이 (초). */
  adaptiveDelay(): number {
    const max = Math.max(...Object.values(this.state));
    if (max >= 0.8) return 1;
    if (max >= 0.5) return 10;
    if (max >= 0.3) return 30;
    if (max >= 0.1) return 120;
    return 300;
  }

  snapshot(): DriveState {
    return { ...this.state };
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
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async runAll(): Promise<ProbeResult[]> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const probes: Array<{
      name: string;
      cmd: string;
      parse: (out: string) => { observation: string; severity: number };
    }> = [
      {
        name: "uncommitted_changes",
        cmd: "git diff --stat | tail -1",
        parse: (out) => {
          if (!out.trim()) return { observation: "uncommitted 변경 없음", severity: 0 };
          return { observation: `uncommitted: ${out.trim()}`, severity: 0.3 };
        },
      },
      {
        name: "todo_count",
        cmd: 'grep -r "TODO\\|FIXME" src/ 2>/dev/null | wc -l',
        parse: (out) => {
          const n = parseInt(out.trim()) || 0;
          if (n === 0) return { observation: "TODO/FIXME 없음", severity: 0 };
          if (n < 10) return { observation: `TODO/FIXME ${n}개`, severity: 0.2 };
          return { observation: `TODO/FIXME ${n}개 (많음)`, severity: 0.5 };
        },
      },
      {
        name: "stale_branches",
        cmd: "git branch --merged 2>/dev/null | grep -v '\\*\\|main\\|master' | wc -l",
        parse: (out) => {
          const n = parseInt(out.trim()) || 0;
          if (n <= 1) return { observation: "stale branch 없음", severity: 0 };
          return { observation: `병합 완료 브랜치 ${n}개`, severity: 0.3 };
        },
      },
      {
        name: "recent_activity",
        cmd: "git log --since=3days --oneline 2>/dev/null | wc -l",
        parse: (out) => {
          const n = parseInt(out.trim()) || 0;
          if (n === 0) return { observation: "최근 3일 커밋 없음", severity: 0.2 };
          return { observation: `최근 3일 커밋 ${n}건`, severity: 0 };
        },
      },
      {
        name: "disk_usage",
        cmd: "du -sm . 2>/dev/null | cut -f1",
        parse: (out) => {
          const mb = parseInt(out.trim()) || 0;
          if (mb < 500) return { observation: `디스크 ${mb}MB`, severity: 0 };
          return { observation: `디스크 ${mb}MB (과다)`, severity: 0.4 };
        },
      },
    ];

    const results: ProbeResult[] = [];
    for (const probe of probes) {
      try {
        const { stdout } = await execFileAsync("/bin/sh", ["-c", probe.cmd], {
          cwd: this.cwd,
          timeout: 10_000,
        });
        const { observation, severity } = probe.parse(stdout);
        results.push({ name: probe.name, observation, severity, summary: observation });
      } catch {
        // probe 실패는 무시
      }
    }

    this.pendingResults = results;
    return results;
  }
}

// ─── Cost Controller ────────────────────────────────────────────────

class CostController {
  private todayUsd = 0;
  private dailyBudgetUsd = 1.0;
  private l2Calls = 0;
  private l3Calls = 0;
  private maxL3PerDay = 10;
  private lastResetDate = new Date().toDateString();

  maybeResetDay(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.todayUsd = 0;
      this.l2Calls = 0;
      this.l3Calls = 0;
      this.lastResetDate = today;
    }
  }

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

  restore(saved: { todayUsd: number; l2Calls: number; l3Calls: number }, savedAt?: string): void {
    // 날짜가 바뀌었으면 어제 비용은 무시
    if (savedAt) {
      const savedDate = new Date(savedAt).toDateString();
      if (savedDate !== new Date().toDateString()) return;
    }
    this.todayUsd = saved.todayUsd;
    this.l2Calls = saved.l2Calls;
    this.l3Calls = saved.l3Calls;
  }
}

// ─── State Store (Disk Persistence) ─────────────────────────────────

interface SavedState {
  drives: DriveState;
  costs: { todayUsd: number; l2Calls: number; l3Calls: number };
  suppressedTopics?: string[];
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
  runSubagent: (prompt: string) => Promise<string | null>;
}

class CognitiveTimer {
  private config: CognitiveTimerConfig;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false; // concurrency guard
  private lastTickMs = Date.now();
  private _lastProactiveAt = 0;
  private dailyProactiveCount = 0;
  /** 이미 보고한 probe 이름 — 상태가 해결될 때까지 재보고하지 않음 */
  private reportedProbes = new Set<string>();
  /** 이미 보낸 탐색 주제 (반복 방지) */
  private reportedExplorations = new Set<string>();
  /** 사용자가 "ㄴㄴ" 등으로 관심없다고 한 주제 */
  private suppressedTopics = new Set<string>();
  /** 마지막으로 보낸 탐색 주제 (ㄴㄴ 매칭용) */
  private lastExplorationTopic = "";
  /** 마지막 shell probe 실행 시각 (시작 시 현재 시각으로 — 1시간 뒤부터 실행) */
  private lastShellProbeAt = Date.now(); // 시작 시 현재 시각 → 1시간 뒤부터 실행
  /** 일일 카운트 리셋 추적용 */
  private lastResetDate = new Date().toDateString();

  constructor(config: CognitiveTimerConfig) {
    this.config = config;
  }

  /** 특정 주제를 탐색 금지 목록에 추가 */
  suppressTopic(keyword: string): void {
    this.suppressedTopics.add(keyword.toLowerCase());
    console.log(`[Lumen] topic suppressed: ${keyword}`);
  }

  /** 억제된 주제 Set 접근자 */
  get suppressedTopicsSet(): Set<string> {
    return this.suppressedTopics;
  }

  /** 저장된 억제 주제 복원 */
  restoreSuppressed(topics: string[]): void {
    for (const t of topics) this.suppressedTopics.add(t);
  }

  /** 모든 억제된 주제를 해제 */
  clearSuppressed(): void {
    this.suppressedTopics.clear();
    console.log("[Lumen] all suppressed topics cleared");
  }

  /** 마지막으로 탐색한 주제 */
  get lastTopic(): string {
    return this.lastExplorationTopic;
  }

  /** 마지막 능동 메시지 발송 시각 */
  get lastProactiveAt(): number {
    return this._lastProactiveAt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickMs = Date.now();
    this.scheduleNext(10_000); // 첫 tick 10초 후
  }

  stop(): void {
    this.running = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timerId = setTimeout(() => {
      this.tick().catch((err) => {
        console.error("[Lumen] tick error:", err);
        // scheduleNext는 tick()의 finally에서 처리 — 여기서 호출하면 이중 스케줄링
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    const now = Date.now();
    try {
      // 0. 일일 카운터 리셋
      const todayStr = new Date().toDateString();
      if (todayStr !== this.lastResetDate) {
        this.dailyProactiveCount = 0;
        this.lastResetDate = todayStr;
      }
      this.config.costs.maybeResetDay();

      // 1. Drive 시간 경과 반영
      const elapsedSec = Math.min((now - this.lastTickMs) / 1000, 3600);
      this.lastTickMs = now;
      this.config.drives.tick(elapsedSec);

      const state = this.config.drives.getState();
      console.log(
        `[Lumen] tick: duty=${state.duty.toFixed(2)} vig=${state.vigilance.toFixed(2)} soc=${state.social.toFixed(2)} cur=${state.curiosity.toFixed(2)} elapsed=${elapsedSec.toFixed(0)}s`,
      );

      // 2. Curiosity 기반 자율 탐색 — 2단계: 경량 판단 → 풀 탐색
      if (state.curiosity > 0.1 && state.duty < 0.5 && state.vigilance < 0.5) {
        if (!this.checkRateLimit(now)) {
          console.log("[Lumen] rate limit — skipping exploration");
        } else {
          const suppressedList = [...this.suppressedTopics].join(", ") || "없음";
          const timeStr = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

          // Gemini 직접 탐색 — memory_search + 웹 검색 + 맥락 파악 전부 Gemini가 수행
          console.log("[Lumen] running Gemini exploration");
          const recentTopics = [...this.reportedExplorations].join(", ") || "없음";
          {
            const fullPrompt = `지금: ${timeStr} (서울)

memory_search로 사용자의 관심사와 작업 맥락을 먼저 파악해.
그 다음, 사용자에게 지금 진짜 도움되는 정보를 웹 검색으로 찾아.

절대 규칙:
- 이미 보낸 주제 다시 보내면 안 됨: [${recentTopics}]
- 날씨는 이미 보냈어. 날씨 금지.
- <final> 태그 쓰지 마.
- 친구한테 카톡하듯이 자연스럽게 써.
- 진짜 유용하거나 흥미로운 것만. 억지로 쥐어짜지 마.
- 없으면 "없음". 없는 게 낫다.

좋은 예: 사용자 GitHub 레포 관련 소식, 사용자가 쓰는 기술 관련 업데이트, 재밌는 밈, 충격적 뉴스, 사용자 프로젝트에 도움되는 정보
금지: ${suppressedList}`;

            const result = await this.config.runSubagent(fullPrompt);

            // <final> 태그 제거
            const cleaned = result?.replace(/<\/?final>/g, "").trim() ?? "";
            if (cleaned && cleaned !== "없음" && !cleaned.startsWith("없음")) {
              this.lastExplorationTopic = cleaned.substring(0, 50);
              this.reportedExplorations.add(this.lastExplorationTopic);
              // 최대 20개만 유지
              if (this.reportedExplorations.size > 20) {
                const first = this.reportedExplorations.values().next().value;
                if (first) this.reportedExplorations.delete(first);
              }
              const message = cleaned;
              console.log("[Lumen] sending exploration message");
              await this.config.onProactiveMessage(message);
              this._lastProactiveAt = now;
              this.dailyProactiveCount++;
              this.config.drives.satisfy(DriveType.CURIOSITY, 0.3);
              this.config.drives.satisfy(DriveType.SOCIAL, 0.3);
            } else {
              console.log("[Lumen] LLM exploration returned nothing useful");
            }
          } // gate YES
        } // rate limit
      } // curiosity check

      // 3. Shell probes (코드 관련) — 1시간에 한 번만 실행
      const oneHourMs = 60 * 60 * 1000;
      if (now - this.lastShellProbeAt >= oneHourMs) {
        console.log("[Lumen] running hourly shell probes");
        this.lastShellProbeAt = now;
        const results = await this.config.probes.runAll();

        const important = results.filter((r: { severity: number }) => r.severity >= 0.2);
        const currentNames = new Set(important.map((r) => r.name));
        for (const name of this.reportedProbes) {
          if (!currentNames.has(name)) this.reportedProbes.delete(name);
        }
        const newFindings = important.filter((r) => !this.reportedProbes.has(r.name));

        if (newFindings.length > 0) {
          const userActive = await this.isUserActiveLocally();
          if (!userActive) {
            for (const r of newFindings) this.reportedProbes.add(r.name);
            const lines = newFindings.map(
              (r: { name: string; observation: string; severity: number }) =>
                `• [${r.name}] ${r.observation} (심각도: ${(r.severity * 100).toFixed(0)}%)`,
            );
            const message = `🔍 환경 점검 결과:\n\n${lines.join("\n")}\n\n확인이 필요해 보이는 항목이 있어요. 살펴볼까요?`;
            console.log("[Lumen] sending probe message:", lines.length, "items");
            await this.config.onProactiveMessage(message);
            // shell probe 발송은 LLM 탐색 rate limit에 영향 안 줌
            this.config.drives.satisfy(DriveType.CURIOSITY, 0.2);
          }
        }
      }
    } finally {
      // 4. State 저장 + 다음 tick 스케줄 (throw 여부와 무관하게 항상 실행)
      try {
        this.config.stateStore.save({
          drives: this.config.drives.getState(),
          costs: {
            todayUsd: this.config.costs.getSummary().todayUsd,
            l2Calls: this.config.costs.getSummary().l2Calls,
            l3Calls: this.config.costs.getSummary().l3Calls,
          },
          suppressedTopics: [...this.suppressedTopics],
          savedAt: new Date().toISOString(),
        });
      } catch {
        /* state save 실패는 무시 */
      }

      // 5. 다음 tick 스케줄 (adaptive delay)
      this.ticking = false;
      if (this.running) {
        const delayMs = this.config.drives.adaptiveDelay() * 1000;
        this.scheduleNext(delayMs);
      }
    } // finally
  }

  /** 사용자가 현재 컴퓨터를 사용 중인지 판단 (idle time 기반). */
  private async isUserActiveLocally(): Promise<boolean> {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      // macOS: ioreg로 HID idle time 확인 (초 단위)
      // 5분(300초) 이내 입력이 있으면 활동 중
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "/bin/sh",
          ["-c", "ioreg -c IOHIDSystem | awk '/HIDIdleTime/{print int($NF/1000000000)}'"],
          { timeout: 3000 },
        );
        const idleSec = parseInt(stdout.trim(), 10);
        return !isNaN(idleSec) && idleSec < 300;
      }
      // Linux: xprintidle (밀리초) 또는 who -u의 idle 컬럼
      const { stdout } = await execFileAsync(
        "/bin/sh",
        ["-c", "xprintidle 2>/dev/null || echo 999999999"],
        { timeout: 3000 },
      );
      const idleMs = parseInt(stdout.trim(), 10);
      return !isNaN(idleMs) && idleMs < 300_000;
    } catch {
      // 실패하면 활동 중이 아닌 걸로 간주
    }
    return false;
  }

  /** 최근 대화에서 사용자 맥락 추출 ($0, 로컬 파일 읽기). */
  private async getUserContext(): Promise<string> {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sessDir = path.join(process.env.HOME || "~", ".openclaw/agents/main/sessions");
      // 가장 최근 세션 파일 찾기
      const files = fs
        .readdirSync(sessDir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => ({
          name: f,
          mtime: fs.statSync(path.join(sessDir, f)).mtimeMs,
        }))
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

      if (files.length === 0) return "";

      // 최근 세션에서 user/assistant 메시지 추출 (마지막 10개)
      const content = fs.readFileSync(path.join(sessDir, files[0].name), "utf-8");
      const lines = content.trim().split("\n").slice(-50);
      const messages: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const role = entry?.message?.role;
          if (role === "user" || role === "assistant") {
            const text = Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((c: any) => c?.type === "text")
                  .map((c: any) => c.text)
                  .join("")
              : String(entry.message.content || "");
            // 짧게 요약
            const trimmed = text.replace(/<[^>]+>/g, "").substring(0, 150);
            if (trimmed) messages.push(`${role}: ${trimmed}`);
          }
        } catch {
          /* skip malformed lines */
        }
      }
      return messages.slice(-10).join("\n");
    } catch {
      return "";
    }
  }

  /** Ollama 로컬 모델로 gate 판단 — 완전 무료 ($0). */
  private async callOllamaGate(prompt: string): Promise<string | null> {
    try {
      const resp = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen2.5-coder:32b",
          prompt,
          stream: false,
          options: { num_predict: 200, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(60_000), // 32B 모델 첫 로딩 시간 고려
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { response?: string };
      return data.response?.trim() ?? null;
    } catch (err) {
      console.log("[Lumen] ollama gate failed, falling back to subagent:", err);
      // Ollama 실패 시 subagent로 폴백
      return this.config.runSubagent(prompt);
    }
  }

  private checkRateLimit(now: number): boolean {
    // 최소 5분 간격
    if (now - this._lastProactiveAt < 30 * 60 * 1000) return false; // 30분 간격
    // 일 20회 제한
    if (this.dailyProactiveCount >= 100) return false; // 1분 간격이니 넉넉히
    return true;
  }
}

// ─── User Feedback Detection Patterns ───────────────────────────────

const REJECTION_PATTERNS = [
  /^ㄴㄴ$/,
  /^노노$/,
  /^ㄴ$/,
  /관심\s*없/,
  /그만/,
  /필요\s*없/,
  /보내지\s*마/,
  /알림\s*끄/,
  /됐어/,
  /싫어/,
  /별로/,
];

const UNSUPPRESS_PATTERNS = [/다시\s*(보내|알려)/, /알림\s*(켜|다시)/, /복구/];

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
    // 기본 chatId: OpenClaw config의 allowFrom에서 가져옴
    let lastChatId: string | null = process.env.LUMEN_CHAT_ID ?? null;

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
        costs.restore(saved.costs, saved.savedAt);
      }

      // Start the adaptive cognitive timer
      const savedSuppressed = saved?.suppressedTopics ?? [];
      timer = new CognitiveTimer({
        drives,
        probes,
        costs,
        stateStore: store,
        onProactiveMessage: async (message: string) => {
          if (lastChatId) {
            await api.runtime.channel.telegram.sendMessageTelegram(lastChatId, message, {});
            drives.satisfy(DriveType.SOCIAL, 0.5);
          }
        },
        runSubagent: async (prompt: string) => {
          try {
            const sessionKey = `agent:main:lumen-explore-${Date.now()}`;
            const { runId } = await api.runtime.subagent.run({
              sessionKey,
              message: prompt,
              idempotencyKey: `lumen-explore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            });
            const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });
            if (waitResult.status !== "ok") {
              await api.runtime.subagent.deleteSession({ sessionKey });
              return null;
            }
            const { messages } = await api.runtime.subagent.getSessionMessages({
              sessionKey,
              limit: 1,
            });
            await api.runtime.subagent.deleteSession({ sessionKey });
            const last = messages[messages.length - 1] as any;
            console.log(
              "[Lumen] subagent response type:",
              typeof last,
              JSON.stringify(last)?.substring(0, 200),
            );
            if (!last) return null;
            // OpenClaw 메시지 형식: {role, content} 또는 {role, content: [{type, text}]}
            if (typeof last === "string") return last;
            if (typeof last?.content === "string") return last.content;
            if (Array.isArray(last?.content)) {
              const texts = last.content
                .filter((c: any) => c?.type === "text" || typeof c === "string")
                .map((c: any) => (typeof c === "string" ? c : (c?.text ?? "")))
                .filter(Boolean);
              return texts.join("\n") || null;
            }
            if (typeof last?.text === "string") return last.text;
            return null;
          } catch (err) {
            console.error("[Lumen] subagent exploration failed:", err);
            return null;
          }
        },
      });
      if (savedSuppressed.length > 0) timer.restoreSuppressed(savedSuppressed);
      timer.start();

      api.logger.info("Lumen cognitive engine initialized");
    });

    // Hook 2: gateway_stop — persist state and stop timer
    api.on("gateway_stop", async () => {
      timer?.stop();
      store?.save({
        drives: drives?.getState() ?? { duty: 0, vigilance: 0, social: 0, curiosity: 0 },
        costs: {
          todayUsd: costs?.getSummary().todayUsd ?? 0,
          l2Calls: costs?.getSummary().l2Calls ?? 0,
          l3Calls: costs?.getSummary().l3Calls ?? 0,
        },
        suppressedTopics: timer ? [...timer.suppressedTopicsSet] : [],
        savedAt: new Date().toISOString(),
      });
      api.logger.info("Lumen cognitive engine stopped, state persisted");
    });

    // Hook 3: before_prompt_build — inject cognitive state into system prompt
    api.on("before_prompt_build", async (_event, _ctx) => {
      if (!drives) return {};
      const level = evaluateThinkLevel(drives);
      const snap = drives.snapshot();
      const context = buildLumenContext({
        drives,
        probeResults: probes.pendingResults,
        costSummary: costs.getSummary(),
      });
      api.logger.info(
        `[Lumen] prompt injected: ${level} duty=${snap.duty.toFixed(2)} soc=${snap.social.toFixed(2)} cur=${snap.curiosity.toFixed(2)}`,
      );
      return { appendSystemContext: context };
    });

    // Hook 4: before_model_resolve — select model based on drive urgency
    api.on("before_model_resolve", async (_event, _ctx) => {
      if (!drives || !costs) return {};
      const level = evaluateThinkLevel(drives);
      const actual = costs.downgradeLevel(level);
      if (actual === "L3") {
        return { modelOverride: "gemini-3-pro" };
      }
      return { modelOverride: "gemini-2.5-flash" };
    });

    // Hook 5: message_received — stimulate drives on user input + feedback detection
    api.on("message_received", async (event, _ctx) => {
      if (!drives) return;
      drives.beginCycle();
      drives.stimulate(DriveType.SOCIAL, 0.7);
      drives.stimulate(DriveType.DUTY, 0.5);

      // Cache chat ID for proactive messaging
      if (event.from) {
        lastChatId = event.from;
      }

      // Check if user is rejecting the last proactive topic
      const messageText = String(event.content || event.text || "").trim();
      const isRejection = REJECTION_PATTERNS.some((p) => p.test(messageText));

      if (isRejection && timer) {
        const lastTopic = timer.lastTopic;
        const recentEnough = Date.now() - timer.lastProactiveAt < 3 * 60 * 1000;
        if (lastTopic && recentEnough) {
          timer.suppressTopic(lastTopic);
          // Send acknowledgment
          if (lastChatId) {
            await api.runtime.channel.telegram.sendMessageTelegram(
              lastChatId,
              `알겠어요, "${lastTopic}" 관련 알림은 더 이상 보내지 않을게요 👍`,
              {},
            );
          }
        }
      }

      // Check if user wants to re-enable suppressed topics
      const isUnsuppress = UNSUPPRESS_PATTERNS.some((p) => p.test(messageText));
      if (isUnsuppress && timer) {
        timer.clearSuppressed();
        if (lastChatId) {
          await api.runtime.channel.telegram.sendMessageTelegram(
            lastChatId,
            "알겠어요, 모든 알림을 다시 보내드릴게요 🔔",
            {},
          );
        }
      }
    });

    // Hook 6: agent_end — satisfy drives after successful response
    api.on("agent_end", async (_event, _ctx) => {
      if (!drives) return;
      drives.satisfy(DriveType.SOCIAL, 0.5);
      drives.satisfy(DriveType.DUTY, 0.3);
    });

    // Hook 7: llm_output — track token usage for cost control
    api.on("llm_output", async (event, _ctx) => {
      if (!drives || !costs) return;
      const level = evaluateThinkLevel(drives);
      costs.recordCall(level, event.usage?.input ?? 0, event.usage?.output ?? 0);
    });
  },
});
