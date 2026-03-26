/**
 * State Store — JSON file persistence for Lumen extension state.
 *
 * Persists drive levels, cost records, and timing data to
 * ~/.openclaw/lumen-state.json with atomic writes.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { LumenState } from "./types.js";

/** Default persistence path. */
const STATE_PATH = join(homedir(), ".openclaw", "lumen-state.json");

/**
 * Save Lumen state to disk via atomic write (write .tmp then rename).
 * Creates the parent directory if it does not exist.
 */
export function save(state: LumenState, path: string = STATE_PATH): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Load Lumen state from disk.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function load(path: string = STATE_PATH): LumenState | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (data === null || typeof data !== "object") return null;
    return data as LumenState;
  } catch {
    // File missing, unreadable, or malformed JSON — start fresh.
    return null;
  }
}
