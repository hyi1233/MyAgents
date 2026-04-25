/**
 * Pattern 6 §6.2.1 — correlation context propagation.
 *
 * Verifies:
 *  (a) `withLogContext({ sessionId: 'X' })` makes a `console.warn(...)`
 *      inside its body produce a LogEntry whose `sessionId === 'X'`.
 *  (b) Nested `withLogContext` merges fields — outer `sessionId` plus
 *      inner `turnId` both land on the entry.
 *  (c) Outside any context wrapper, `sessionId` (and friends) is undefined.
 *
 * The capture path under test:
 *   console.warn(...) → patched by initLogger → createAndBroadcast()
 *     → reads getLogContext() → merges fields onto LogEntry
 *     → invokes broadcastLog() (we install a recording broadcaster)
 *
 * No SSE / no real broadcast — we just intercept what the logger would
 * have sent to clients.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLogger, restoreConsole, withLogContext } from '../logger';
import type { LogEntry } from '../../renderer/types/log';

let captured: LogEntry[] = [];
const fakeClients = [
  {
    send: (event: string, data: unknown) => {
      if (event === 'chat:log') captured.push(data as LogEntry);
    },
  } as unknown as { send: (event: string, data: unknown) => void },
];

beforeEach(() => {
  captured = [];
  // Cast through unknown — initLogger expects a strict SSE client type, but
  // for this test we only care about `.send(event, data)` being callable.
  initLogger(() => fakeClients as unknown as ReturnType<
    typeof import('../sse').createSseClient
  >['client'][]);
});

afterEach(() => {
  restoreConsole();
  captured = [];
});

describe('Pattern 6 — withLogContext correlation injection', () => {
  it('(a) injects sessionId into a console.warn inside the wrapper', () => {
    withLogContext({ sessionId: 'X' }, () => {
      console.warn('[test] hello');
    });
    expect(captured.length).toBeGreaterThan(0);
    const e = captured.find(c => c.message === '[test] hello');
    expect(e).toBeDefined();
    expect(e!.sessionId).toBe('X');
    // Other fields stay undefined unless explicitly provided.
    expect(e!.turnId).toBeUndefined();
    expect(e!.tabId).toBeUndefined();
  });

  it('(b) nested withLogContext merges fields', () => {
    withLogContext({ sessionId: 'S1', tabId: 'T1' }, () => {
      withLogContext({ turnId: 'turn-1' }, () => {
        console.warn('[test] nested');
      });
    });
    const e = captured.find(c => c.message === '[test] nested');
    expect(e).toBeDefined();
    expect(e!.sessionId).toBe('S1');
    expect(e!.tabId).toBe('T1');
    expect(e!.turnId).toBe('turn-1');
  });

  it('(c) outside any context, correlation fields are undefined', () => {
    console.warn('[test] outside');
    const e = captured.find(c => c.message === '[test] outside');
    expect(e).toBeDefined();
    expect(e!.sessionId).toBeUndefined();
    expect(e!.tabId).toBeUndefined();
    expect(e!.turnId).toBeUndefined();
    expect(e!.requestId).toBeUndefined();
    expect(e!.runtime).toBeUndefined();
    expect(e!.ownerId).toBeUndefined();
  });

  it('(d) async work inside withLogContext keeps the frame across awaits', async () => {
    await withLogContext({ sessionId: 'async-session' }, async () => {
      await Promise.resolve();
      await new Promise(r => setTimeout(r, 1));
      console.warn('[test] after await');
    });
    const e = captured.find(c => c.message === '[test] after await');
    expect(e).toBeDefined();
    expect(e!.sessionId).toBe('async-session');
  });
});
