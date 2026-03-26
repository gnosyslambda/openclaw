/**
 * ProbeRunner — Shell-based environment monitoring probes.
 *
 * Uses Node.js child_process.execFile (NOT exec) for security.
 * All complex pipelines are run via /bin/sh -c [...].
 */

import { execFile } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProbeResult {
  name: string;
  value: number;
  observation: string;
  severity: number;
}

export interface Probe {
  name: string;
  command: string;
  args: string[];
  parser: (output: string) => ProbeResult;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shellProbe(
  name: string,
  shell: string,
  parser: (output: string) => ProbeResult,
  intervalMs: number,
): Probe {
  return {
    name,
    command: "/bin/sh",
    args: ["-c", shell],
    parser,
    intervalMs,
    lastRun: 0,
    enabled: true,
  };
}

function numericParser(
  name: string,
  unit: string,
  severityFn: (n: number) => number,
): (output: string) => ProbeResult {
  return (output: string): ProbeResult => {
    const n = parseInt(output.trim(), 10) || 0;
    const sev = Math.min(1, Math.max(0, severityFn(n)));
    return {
      name,
      value: sev,
      observation: `${n} ${unit}`,
      severity: sev,
    };
  };
}

// ─── ProbeRunner ────────────────────────────────────────────────────────────

export class ProbeRunner {
  private probes: Map<string, Probe> = new Map();
  public pendingResults: ProbeResult[] = [];
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
    this.registerBuiltins();
  }

  // ── Builtin Registration ────────────────────────────────────────────────

  registerBuiltins(): void {
    const builtins: Probe[] = [
      // 1. todo_count — 10 min
      shellProbe(
        "todo_count",
        'grep -r "TODO\\|FIXME" src/ 2>/dev/null | wc -l',
        numericParser("todo_count", "TODOs/FIXMEs", (n) => Math.min(1, n / 50)),
        10 * 60 * 1000,
      ),

      // 2. stale_branches — 1 hr
      shellProbe(
        "stale_branches",
        "git branch --merged 2>/dev/null | grep -v '*\\|main\\|master' | wc -l",
        numericParser("stale_branches", "stale branches", (n) => Math.min(1, n / 10)),
        60 * 60 * 1000,
      ),

      // 3. recent_activity — 30 min
      shellProbe(
        "recent_activity",
        "git log --since=3days --oneline 2>/dev/null | wc -l",
        (output: string): ProbeResult => {
          const n = parseInt(output.trim(), 10) || 0;
          // Low activity is higher severity (nothing happening)
          const severity = n === 0 ? 0.8 : n < 3 ? 0.4 : 0.1;
          return {
            name: "recent_activity",
            value: Math.min(1, n / 30),
            observation: `${n} commits in last 3 days`,
            severity,
          };
        },
        30 * 60 * 1000,
      ),

      // 4. disk_usage — 1 hr
      shellProbe(
        "disk_usage",
        "du -sm . 2>/dev/null | cut -f1",
        numericParser("disk_usage", "MB", (n) => Math.min(1, n / 5000)),
        60 * 60 * 1000,
      ),

      // 5. uncommitted_changes — 5 min
      shellProbe(
        "uncommitted_changes",
        "git diff --stat 2>/dev/null | tail -1",
        (output: string): ProbeResult => {
          const trimmed = output.trim();
          const hasChanges = trimmed.length > 0;
          const match = trimmed.match(/(\d+)\s+files?\s+changed/);
          const fileCount = match ? parseInt(match[1], 10) : 0;
          return {
            name: "uncommitted_changes",
            value: Math.min(1, fileCount / 20),
            observation: hasChanges ? trimmed : "clean working tree",
            severity: Math.min(1, fileCount / 10),
          };
        },
        5 * 60 * 1000,
      ),

      // 6. hardcoded_secrets — 1 hr
      shellProbe(
        "hardcoded_secrets",
        'grep -rn "password\\s*=\\|api_key\\s*=\\|secret\\s*=\\|token\\s*=\\|PRIVATE.KEY" src/ 2>/dev/null | grep -v "node_modules" | wc -l',
        (output: string): ProbeResult => {
          const n = parseInt(output.trim(), 10) || 0;
          return {
            name: "hardcoded_secrets",
            value: Math.min(1, n / 5),
            observation: n === 0 ? "no hardcoded secrets detected" : `${n} potential hardcoded secrets`,
            severity: n > 0 ? Math.min(1, 0.5 + n * 0.1) : 0,
          };
        },
        60 * 60 * 1000,
      ),

      // 7. env_in_git — 1 hr
      shellProbe(
        "env_in_git",
        "git ls-files .env .env.local 2>/dev/null | wc -l",
        (output: string): ProbeResult => {
          const n = parseInt(output.trim(), 10) || 0;
          return {
            name: "env_in_git",
            value: n > 0 ? 1 : 0,
            observation: n > 0 ? `${n} .env files tracked in git` : "no .env files in git",
            severity: n > 0 ? 1 : 0,
          };
        },
        60 * 60 * 1000,
      ),

      // 8. github_actions — 10 min
      shellProbe(
        "github_actions",
        "gh run list --limit 3 --json status,conclusion,name 2>/dev/null",
        (output: string): ProbeResult => {
          const trimmed = output.trim();
          if (!trimmed || trimmed === "[]") {
            return {
              name: "github_actions",
              value: 0,
              observation: "no recent workflow runs",
              severity: 0,
            };
          }
          try {
            const runs = JSON.parse(trimmed) as Array<{
              status: string;
              conclusion: string;
              name: string;
            }>;
            const failed = runs.filter((r) => r.conclusion === "failure").length;
            const summary = runs
              .map((r) => `${r.name}: ${r.conclusion || r.status}`)
              .join(", ");
            return {
              name: "github_actions",
              value: Math.min(1, failed / runs.length),
              observation: summary,
              severity: failed > 0 ? Math.min(1, 0.4 + failed * 0.2) : 0,
            };
          } catch {
            return {
              name: "github_actions",
              value: 0,
              observation: "failed to parse gh output",
              severity: 0.2,
            };
          }
        },
        10 * 60 * 1000,
      ),

      // 9. outdated_deps — 24 hr
      shellProbe(
        "outdated_deps",
        "npm outdated --json 2>/dev/null || echo '{}'",
        (output: string): ProbeResult => {
          const trimmed = output.trim();
          try {
            const deps = JSON.parse(trimmed || "{}") as Record<string, unknown>;
            const count = Object.keys(deps).length;
            return {
              name: "outdated_deps",
              value: Math.min(1, count / 30),
              observation: count === 0 ? "all deps up to date" : `${count} outdated packages`,
              severity: Math.min(1, count / 20),
            };
          } catch {
            return {
              name: "outdated_deps",
              value: 0,
              observation: "failed to parse npm outdated output",
              severity: 0.1,
            };
          }
        },
        24 * 60 * 60 * 1000,
      ),

      // 10. listening_ports — 30 min
      shellProbe(
        "listening_ports",
        "lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | wc -l",
        numericParser("listening_ports", "listening ports", (n) =>
          n > 10 ? 0.7 : n > 5 ? 0.3 : 0.1,
        ),
        30 * 60 * 1000,
      ),

      // 11. memory_usage — 10 min (uses process.pid)
      shellProbe(
        "memory_usage",
        `ps -o rss= -p ${process.pid} 2>/dev/null`,
        (output: string): ProbeResult => {
          const kbStr = output.trim();
          const kb = parseInt(kbStr, 10) || 0;
          const mb = Math.round(kb / 1024);
          return {
            name: "memory_usage",
            value: Math.min(1, mb / 2048),
            observation: `${mb} MB RSS`,
            severity: mb > 1024 ? 0.7 : mb > 512 ? 0.4 : 0.1,
          };
        },
        10 * 60 * 1000,
      ),

      // 12. lint_check — 10 min
      shellProbe(
        "lint_check",
        "npx tsc --noEmit 2>&1 | grep -c error || echo 0",
        numericParser("lint_check", "type errors", (n) =>
          n > 20 ? 0.9 : n > 5 ? 0.5 : n > 0 ? 0.3 : 0,
        ),
        10 * 60 * 1000,
      ),

      // 13. test_status — 1 hr
      shellProbe(
        "test_status",
        "npm test 2>&1 | tail -1",
        (output: string): ProbeResult => {
          const line = output.trim().toLowerCase();
          const passed = line.includes("pass") && !line.includes("fail");
          const failed = line.includes("fail");
          return {
            name: "test_status",
            value: failed ? 1 : passed ? 0 : 0.5,
            observation: output.trim() || "no test output",
            severity: failed ? 0.8 : passed ? 0 : 0.3,
          };
        },
        60 * 60 * 1000,
      ),
    ];

    for (const probe of builtins) {
      this.probes.set(probe.name, probe);
    }
  }

  // ── Execution ───────────────────────────────────────────────────────────

  async runProbe(probe: Probe): Promise<ProbeResult | null> {
    if (!probe.enabled) return null;

    return new Promise((resolve) => {
      execFile(
        probe.command,
        probe.args,
        {
          cwd: this.workingDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (_error, stdout, stderr) => {
          probe.lastRun = Date.now();
          try {
            // Use stdout even if exit code is non-zero (grep returns 1 on no match)
            const output = stdout || stderr || "";
            const result = probe.parser(output);
            resolve(result);
          } catch {
            resolve({
              name: probe.name,
              value: 0,
              observation: `probe error: ${_error?.message ?? "unknown"}`,
              severity: 0.1,
            });
          }
        },
      );
    });
  }

  async runDueProbes(): Promise<ProbeResult[]> {
    const now = Date.now();
    const due: Probe[] = [];

    for (const probe of this.probes.values()) {
      if (probe.enabled && now - probe.lastRun >= probe.intervalMs) {
        due.push(probe);
      }
    }

    const results: ProbeResult[] = [];
    const settled = await Promise.allSettled(
      due.map((p) => this.runProbe(p)),
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value !== null) {
        results.push(outcome.value);
        this.pendingResults.push(outcome.value);
      }
    }

    return results;
  }
}
