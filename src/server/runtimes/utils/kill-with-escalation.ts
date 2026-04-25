import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

type KillSignal = NodeJS.Signals | number;

export interface KillEscalationOptions {
  gracefulSignal?: NodeJS.Signals;
  gracefulMs: number;
  hardSignal?: NodeJS.Signals;
  hardMs: number;
  onStep?: (step: 'graceful' | 'hard' | 'orphan', info: { pid: number }) => void;
}

export interface KillResult {
  exited: boolean;
  signalUsed?: 'graceful' | 'hard';
  orphanRisk: boolean;
  elapsedMs: number;
}

export interface EscalatableProcess {
  readonly pid: number;
  readonly exited?: boolean;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: KillSignal): boolean | void;
  waitForExit?: () => Promise<unknown>;
}

function hasExited(proc: EscalatableProcess): boolean {
  if (proc.exited === true) return true;
  if (proc.exitCode !== undefined && proc.exitCode !== null) return true;
  if (proc.signalCode !== undefined && proc.signalCode !== null) return true;
  return false;
}

function waitForProcessExit(proc: EscalatableProcess): Promise<unknown> {
  if (proc.waitForExit) {
    return proc.waitForExit();
  }
  return once(proc as ChildProcess, 'exit');
}

async function waitForExitWithin(proc: EscalatableProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return true;

  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });

  const exitPromise = waitForProcessExit(proc).then(
    () => true,
    () => true,
  );

  const exited = await Promise.race([exitPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return exited || hasExited(proc);
}

export async function killWithEscalation(
  proc: EscalatableProcess,
  opts: KillEscalationOptions,
): Promise<KillResult> {
  const start = Date.now();
  const gracefulSignal = opts.gracefulSignal ?? 'SIGTERM';
  const hardSignal = opts.hardSignal ?? 'SIGKILL';
  let signalUsed: KillResult['signalUsed'];

  const elapsedMs = (): number => Date.now() - start;

  try {
    if (hasExited(proc)) {
      return { exited: true, orphanRisk: false, elapsedMs: 0 };
    }

    opts.onStep?.('graceful', { pid: proc.pid });
    signalUsed = 'graceful';
    try {
      proc.kill(gracefulSignal);
    } catch {
      /* ignore kill failures; exit wait below remains bounded */
    }

    if (await waitForExitWithin(proc, opts.gracefulMs)) {
      return { exited: true, signalUsed, orphanRisk: false, elapsedMs: elapsedMs() };
    }

    opts.onStep?.('hard', { pid: proc.pid });
    signalUsed = 'hard';
    try {
      proc.kill(hardSignal);
    } catch {
      /* ignore kill failures; exit wait below remains bounded */
    }

    if (await waitForExitWithin(proc, opts.hardMs)) {
      return { exited: true, signalUsed, orphanRisk: false, elapsedMs: elapsedMs() };
    }

    opts.onStep?.('orphan', { pid: proc.pid });
    return { exited: false, signalUsed, orphanRisk: true, elapsedMs: elapsedMs() };
  } catch {
    opts.onStep?.('orphan', { pid: proc.pid });
    return { exited: false, signalUsed, orphanRisk: true, elapsedMs: elapsedMs() };
  }
}
