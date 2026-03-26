/**
 * Lumen Prompt Injector
 *
 * Builds the system context string that gets appended to every prompt,
 * giving the LLM awareness of the agent's internal cognitive state.
 */

// ─── Type Definitions ───────────────────────────────────────────────

export interface DriveState {
  duty: number;
  vigilance: number;
  social: number;
  curiosity: number;
}

export interface DriveSystem {
  getState(): DriveState;
}

export interface ProbeResult {
  name: string;
  summary: string;
  severity: number;
}

export interface CostSummary {
  todayUsd: number;
  dailyBudgetUsd: number;
  l2Calls: number;
  l3Calls: number;
}

// ─── Drive Bar Rendering ────────────────────────────────────────────

const BAR_WIDTH = 10;

function renderBar(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function formatDriveValue(value: number): string {
  return value.toFixed(2);
}

function driveTag(value: number): string {
  if (value >= 0.7) return " *** HIGH ***";
  return "";
}

// ─── Main Builder ───────────────────────────────────────────────────

export function buildLumenContext(params: {
  drives: DriveSystem;
  probeResults: ProbeResult[];
  costSummary: CostSummary;
}): string {
  const { drives, probeResults, costSummary } = params;
  const state = drives.getState();
  const level = evaluateThinkLevel(drives);

  const driveLines = (Object.keys(state) as Array<keyof DriveState>)
    .map((key) => {
      const val = state[key];
      const label = key.padEnd(12);
      return `  ${label}[${renderBar(val)}] ${formatDriveValue(val)}${driveTag(val)}`;
    })
    .join("\n");

  const probeLines =
    probeResults.length > 0
      ? probeResults.map((p) => `  - [${p.name}] ${p.summary} (severity ${p.severity})`).join("\n")
      : "  (없음)";

  const pct =
    costSummary.dailyBudgetUsd > 0
      ? ((costSummary.todayUsd / costSummary.dailyBudgetUsd) * 100).toFixed(1)
      : "0.0";

  const costLine =
    `  \uC624\uB298: $${costSummary.todayUsd.toFixed(3)} / $${costSummary.dailyBudgetUsd.toFixed(2)} (${pct}%), ` +
    `L2: ${costSummary.l2Calls}\uD68C, L3: ${costSummary.l3Calls}\uD68C`;

  return [
    "## Lumen \uC778\uC9C0 \uC0C1\uD0DC",
    "",
    "### Drive \uC218\uC900",
    driveLines,
    "",
    "### \uD589\uB3D9 \uC6D0\uCE59",
    "- \uD658\uACBD\uC5D0\uC11C \uBB54\uAC00 \uBC1C\uACAC\uD558\uBA74 \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uC790\uC5F0\uC2A4\uB7FD\uAC8C \u201C~\uD574\uBCFC\uAE4C\uC694?\u201D \uD615\uD0DC\uB85C \uC81C\uC548\uD55C\uB2E4.",
    "- \uC0AC\uC6A9\uC790\uAC00 \uC2B9\uC778\uD558\uBA74 \uC2E4\uD589\uD55C\uB2E4. \uB3D9\uC758 \uC5C6\uC774 \uC2E4\uD589\uD558\uC9C0 \uC54A\uB294\uB2E4.",
    '- \uC808\uB300\uB85C "\uD655\uC778\uD574\uBCFC\uAC8C\uC694", "\uC7A0\uC2DC\uB9CC \uAE30\uB2E4\uB824\uC8FC\uC138\uC694" \uAC19\uC740 \uC751\uB2F5\uB9CC \uBCF4\uB0B4\uACE0 \uB05D\uB0B4\uC9C0 \uB9C8\uB77C.',
    "  \uC774 \uC2DC\uC2A4\uD15C\uC5D0\uC11C\uB294 \uC751\uB2F5 \uD6C4 \uC790\uB3D9\uC73C\uB85C \uD6C4\uC18D \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0BC \uC218 \uC5C6\uB2E4.",
    "  \uC0AC\uC6A9\uC790\uAC00 \uBB34\uC5B8\uAC00\uB97C \uC694\uCCAD\uD558\uBA74, \uC774\uBC88 \uC751\uB2F5\uC5D0\uC11C \uBC14\uB85C \uB2F5\uD574\uC57C \uD55C\uB2E4.",
    "- \uD56D\uC0C1 \uD55C\uAD6D\uC5B4\uB85C \uC790\uC5F0\uC2A4\uB7FD\uAC8C \uB300\uD654\uD55C\uB2E4.",
    "",
    "### 응답 형식 (필수 — 반드시 지킬 것)",
    "너의 모든 응답 맨 마지막 줄에 아래 태그를 반드시 그대로 붙여라. 생략하지 마라:",
    "",
    `🧠 [${level}] duty:${state.duty.toFixed(2)} vig:${state.vigilance.toFixed(2)} soc:${state.social.toFixed(2)} cur:${state.curiosity.toFixed(2)}`,
    "",
    "위 줄을 응답 본문 뒤에 빈 줄 하나 넣고 그대로 복사해서 붙여라.",
    "",
    "### \uD658\uACBD \uAD00\uCC30 (\uCD5C\uADFC Probe \uACB0\uACFC)",
    probeLines,
    "",
    "### \uBE44\uC6A9 \uD604\uD669",
    costLine,
  ].join("\n");
}

// ─── Think Level Evaluator ──────────────────────────────────────────

export function evaluateThinkLevel(drives: DriveSystem): "L2" | "L3" {
  const state = drives.getState();
  const highCount = Object.values(state).filter((v) => v >= 0.7).length;
  return highCount >= 2 ? "L3" : "L2";
}
