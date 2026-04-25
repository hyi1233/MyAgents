/**
 * Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
 *
 * Uses atomic mkdir as the lock primitive — same approach as the renderer-side
 * acquireFileLock and the Rust with_config_lock. Each lockdir contains an
 * `owner` file (`node:<pid>:<startTime>`) used for stale-lock recovery: if
 * the lockdir exists past `staleMs` AND its owner pid is no longer alive (or
 * its pid has been reused — start time mismatch), the lock is forcibly broken
 * before the next acquire attempt.
 *
 * Async polling only — no Atomics.wait / no SharedArrayBuffer / no busy-wait.
 * Throws FileBusyError on timeout (caller can choose to retry or surface).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

export interface FileLockOptions {
  /** Absolute path to the lock directory (e.g. `<file>.lock`). */
  lockPath: string;
  /** Max time to wait for lock acquisition before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** Lock dir age above which we'll attempt stale-recovery if owner is dead. Default 30000ms. */
  staleMs?: number;
  /** Polling interval while waiting. Default 50ms. */
  pollMs?: number;
}

export class FileBusyError extends Error {
  readonly code = 'FILE_BUSY';

  constructor(lockPath: string, timeoutMs: number) {
    super(`File busy: could not acquire lock ${lockPath} within ${timeoutMs}ms; retry`);
    this.name = 'FileBusyError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const DEFAULT_POLL_MS = 50;

/**
 * Process start time in epoch ms — used as a sentinel piece of the owner
 * token so a recycled pid (different process at the same numeric pid) doesn't
 * masquerade as our lock holder. `process.uptime()` returns seconds since
 * the current process started; subtracting from now gives the start instant.
 */
const PROCESS_START_TIME_MS = Math.round(Date.now() - process.uptime() * 1000);

/** Owner token includes runtime, pid, and start_time to defeat pid reuse. */
function ourOwnerToken(): string {
  return `node:${process.pid}:${PROCESS_START_TIME_MS}`;
}

function delay(ms: number): Promise<void> {
  // NOTE: do NOT `.unref()` this timer. Unlike timers in cancellation.ts /
  // UnifiedLogger.ts that are background-polling, this timer is the ONLY
  // thing keeping a `withFileLock(...)` await alive when the lock is held by
  // someone else. Unrefing it would let the Node event loop exit between
  // polls, surfacing as "unsettled top-level await" warnings + zombie
  // processes that never acquire the lock.
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

/**
 * Returns the start time (epoch ms) of `pid`, or `null` if unavailable.
 *
 * Best-effort, platform-specific:
 *   - Linux: parse `/proc/<pid>/stat` field 22 (starttime in clock ticks),
 *           combined with `/proc/uptime` to convert to absolute ms.
 *   - macOS: `ps -p <pid> -o lstart=` (string date), parse via Date.
 *   - Windows: skipped (no cheap way without extra deps; rely on age alone).
 */
function getPidStartTimeMs(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Field 2 is `(comm)` which can contain spaces — split after the
      // closing paren.
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = stat.slice(closeParen + 2).split(' ');
      // After the comm field, fields are 0-indexed: state=fields[0],
      // ppid=fields[1], …, starttime is original index 22 → fields[19].
      const startticks = Number(fields[19]);
      if (!Number.isFinite(startticks)) return null;
      const uptimeStr = readFileSync('/proc/uptime', 'utf-8').split(' ')[0];
      const uptimeSec = Number(uptimeStr);
      if (!Number.isFinite(uptimeSec)) return null;
      // Hertz is typically 100 on Linux; we don't have a portable way to
      // read it from Node, so assume 100. The check is for "matches" so
      // a few-tick error is fine.
      const HZ = 100;
      const startSecAgo = uptimeSec - startticks / HZ;
      return Math.round(Date.now() - startSecAgo * 1000);
    }
    if (process.platform === 'darwin') {
      // `ps -p <pid> -o lstart=` returns e.g. "Thu Apr 25 10:23:45 2026".
      const out = execSync(`ps -p ${pid} -o lstart=`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!out) return null;
      const parsed = Date.parse(out);
      return Number.isFinite(parsed) ? parsed : null;
    }
    // Windows / other: not supported here. TODO: use wmic or PowerShell if
    // needed; for now we fall back to age-only stale detection.
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to break an existing lock if its owner is dead and it is older than `staleMs`.
 *
 * Owner file format (Pattern 5 + fix #4):
 *   - `node:<pid>:<startMs>` / `rust:<pid>:<startMs>`  →
 *       check pid liveness via `process.kill(pid, 0)` AND start-time match.
 *       If pid is alive but start-time mismatches (recycled pid), treat as
 *       stale.
 *   - `node:<pid>` / `rust:<pid>`        → legacy 2-tuple, age + pid only
 *   - `renderer:<ts>`                    → renderer pids aren't observable, skip
 *                                          pid check; only stale-by-age may break it.
 *
 * Returns true if we forcibly removed the lockdir (caller should retry mkdir immediately).
 */
function tryBreakStaleLock(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Lock disappeared between EEXIST and stat — caller will retry mkdir.
    return true;
  }

  if (ageMs <= staleMs) return false;

  // Read owner sentinel
  let owner = '';
  try {
    owner = readFileSync(resolve(lockPath, 'owner'), 'utf-8').trim();
  } catch {
    // No owner file — treat as recoverable purely on age basis.
  }

  // Match 3-tuple (preferred) and 2-tuple (legacy) shapes.
  const match3 = /^(node|rust):(\d+):(\d+)$/.exec(owner);
  const match2 = /^(node|rust):(\d+)$/.exec(owner);
  const match = match3 ?? match2;

  if (match) {
    const pid = Number(match[2]);
    const declaredStart = match3 ? Number(match3[3]) : null;

    // Node's process.kill rejects pids that don't fit in a 32-bit signed int.
    if (Number.isFinite(pid) && pid > 0 && pid <= 0x7fffffff) {
      let pidAlive = false;
      try {
        // Signal 0 = liveness probe.
        process.kill(pid, 0);
        pidAlive = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ESRCH = no such process. EPERM = process exists but we can't signal it
        // (cross-user) — be conservative and leave it alone.
        if (code !== 'ESRCH') {
          // Fall through to AGE-ONLY override below (require >60s before
          // breaking when the pid appears alive but cross-user).
          pidAlive = true;
        }
      }

      if (pidAlive) {
        // Pid-reuse detection: when the owner file declared a start_time,
        // verify the live pid actually matches it. If it doesn't, the pid was
        // recycled by a different process — our original holder is gone.
        if (declaredStart !== null) {
          const liveStart = getPidStartTimeMs(pid);
          if (liveStart !== null) {
            // Allow ~2s of skew between the writer's clock and our read.
            const skew = Math.abs(liveStart - declaredStart);
            if (skew > 2000) {
              console.warn(
                `[file-lock] pid ${pid} reused (declaredStart=${declaredStart} liveStart=${liveStart} skew=${skew}ms); breaking lock ${lockPath}`,
              );
              try {
                rmSync(lockPath, { recursive: true, force: true });
                return true;
              } catch {
                return false;
              }
            }
            // start_time matches — owner is genuinely alive, refuse to break.
            return false;
          }
          // start_time check unsupported on this platform — fall through to
          // age-only override below.
        }

        // Age-only override: require >60s to break a pid-alive lock (gives
        // breathing room over the default 30s staleMs which is just for
        // pid-dead refusal).
        if (ageMs <= 60_000) return false;
        console.warn(
          `[file-lock] lock ${lockPath} held by pid ${pid} for ${ageMs}ms (>60s) — breaking despite live pid (cross-user / start-time-unverifiable)`,
        );
        try {
          rmSync(lockPath, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  // For renderer:<ts> or unrecognized owners we fall through to age-based break.

  console.warn(
    `[file-lock] Breaking stale lock ${lockPath} (age=${ageMs}ms owner=${owner || 'unknown'})`
  );
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire `opts.lockPath` (a directory created via atomic mkdir), run `op`,
 * and always release the lock.
 *
 * Multiple async callers in the same process serialize naturally because
 * mkdirSync is atomic; cross-process callers serialize the same way. Stale
 * locks (owner crashed mid-write) are auto-recovered after `staleMs`.
 */
export async function withFileLock<T>(
  opts: FileLockOptions,
  op: () => Promise<T>
): Promise<T> {
  const lockPath = opts.lockPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const start = Date.now();
  let acquired = false;
  const ourToken = ourOwnerToken();
  while (!acquired) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      try {
        // Owner sentinel includes start_time so pid reuse can't masquerade
        // as us — see tryBreakStaleLock for the verification path.
        writeFileSync(resolve(lockPath, 'owner'), `${ourToken}\n`, 'utf-8');
      } catch {
        // owner file is diagnostic only; missing is non-fatal.
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lockdir already exists — see if it's stale.
      if (tryBreakStaleLock(lockPath, staleMs)) {
        // Retry mkdir immediately — don't sleep.
        continue;
      }

      if (Date.now() - start >= timeoutMs) {
        throw new FileBusyError(lockPath, timeoutMs);
      }
      await delay(pollMs);
    }
  }

  try {
    return await op();
  } finally {
    // Pattern 5 fix #4 release race: another process may have broken our
    // lock as stale (e.g. our process paused past staleMs), then taken its
    // own lock under the same path. We must verify the lock dir still
    // belongs to us before deleting — otherwise we'd evict an unrelated
    // current holder.
    try {
      if (existsSync(lockPath)) {
        let currentOwner = '';
        try {
          currentOwner = readFileSync(resolve(lockPath, 'owner'), 'utf-8').trim();
        } catch {
          // Owner file missing — treat as ours and remove (failsafe so we
          // don't leak the dir; if it's unrelated and lacked an owner file,
          // that's a deeper bug).
          currentOwner = ourToken;
        }
        if (currentOwner === ourToken) {
          rmSync(lockPath, { recursive: true, force: true });
        } else {
          console.warn(
            `[file-lock] our lock at ${lockPath} was broken as stale; not deleting current holder's lock (owner=${currentOwner})`,
          );
        }
      }
    } catch {
      // Best-effort unlock; future timeouts will surface this.
    }
  }
}
