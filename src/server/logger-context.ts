/**
 * Logger context — Pattern 6 (Observability — Correlation IDs).
 *
 * `AsyncLocalStorage` carries correlation fields across `await` boundaries
 * inside a single Node task. Wrap any async unit-of-work with
 * `withLogContext({ ... }, fn)` and every `console.*` call inside (including
 * deeply nested awaits) automatically gets those fields injected by
 * `logger.ts::createAndBroadcast` when it builds the `LogEntry`.
 *
 * The whole point of this module: existing call sites such as
 *   console.warn('[claude-code] timeout')
 * stay byte-for-byte unchanged. The CAPTURE path (in `logger.ts`) is the
 * only thing that reads the store. There is no `sendLog(level, message,
 * meta)` migration — that would violate the "console.* is the unified
 * entry" rule documented in `specs/tech_docs/unified_logging.md` §最佳实践 #1.
 *
 * Three generation points wrap context (see PRD §6.2.1 item 2):
 *   - HTTP request handler in `index.ts`            → requestId/sessionId/tabId
 *   - SDK turn boundary in `agent-session.ts`       → turnId
 *   - Runtime event handling in `runtimes/*.ts`     → runtime
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
    sessionId?: string;
    tabId?: string;
    ownerId?: string;
    requestId?: string;
    turnId?: string;
    /** Runtime label e.g. 'claude-code' | 'codex' | 'gemini' | 'builtin'. */
    runtime?: string;
}

/**
 * Module-singleton ALS. `getStore()` returns `undefined` outside any
 * `withLogContext(...)` wrapper, in which case logs are emitted without
 * correlation fields (current behaviour).
 */
export const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` inside an ALS frame populated with `ctx`. If a parent frame
 * already exists, fields from `ctx` shallow-merge on top (so nested
 * `withLogContext({ turnId })` inside `withLogContext({ sessionId })`
 * yields a frame containing both). `undefined` values in `ctx` do NOT
 * clobber parent fields.
 *
 * Callers may pass either sync or async `fn` — TypeScript infers the
 * return type. The store is automatically torn down when the awaited
 * promise settles or the sync function returns.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
    const parent = logContextStorage.getStore();
    const merged: LogContext = parent ? { ...parent } : {};
    for (const k of Object.keys(ctx) as (keyof LogContext)[]) {
        const v = ctx[k];
        if (v !== undefined) {
            // TS: index signature wants string | undefined per key, but every
            // key is `string | undefined` in our schema → cast through unknown.
            (merged as Record<string, string | undefined>)[k as string] = v;
        }
    }
    return logContextStorage.run(merged, fn);
}

/**
 * Read the current correlation context (or `undefined` outside any
 * `withLogContext` frame). Used by `logger.ts::createAndBroadcast`.
 *
 * If no ALS frame is active, falls back to the module-level "ambient"
 * context (set via `setAmbientLogContext`). Ambient is needed for the
 * SDK turn boundary — the persistent `messageGenerator` yields back into
 * SDK code that runs outside our ALS frames, so logs emitted from the
 * SDK callback path would lose `turnId` without an ambient fallback.
 *
 * Field-level merge: ALS wins per-field, but any field NOT set in ALS
 * picks up its value from ambient. This lets us stamp `turnId` ambiently
 * for the duration of a turn while still letting an HTTP request frame
 * supply `requestId/sessionId/tabId` independently.
 */
export function getLogContext(): LogContext | undefined {
    const als = logContextStorage.getStore();
    if (!als && !ambient) return undefined;
    if (!ambient) return als;
    if (!als) return ambient;
    // Both present — ALS overrides per field that's set there.
    return {
        sessionId: als.sessionId ?? ambient.sessionId,
        tabId: als.tabId ?? ambient.tabId,
        ownerId: als.ownerId ?? ambient.ownerId,
        requestId: als.requestId ?? ambient.requestId,
        turnId: als.turnId ?? ambient.turnId,
        runtime: als.runtime ?? ambient.runtime,
    };
}

/**
 * Module-level ambient context (Pattern 6 SDK-turn fallback).
 *
 * The persistent SDK session in `agent-session.ts` runs a `while(true)`
 * `messageGenerator` that yields user messages back into SDK-internal
 * code paths. ALS frames don't survive that yield/resume cycle cleanly
 * (the SDK callback that emits `chat:log` etc. runs outside our wrapping
 * function), so we stamp `turnId` as ambient for the duration of a turn
 * and clear it when the turn ends.
 *
 * Use ALS (`withLogContext`) for short-lived frames where call-stack
 * propagation works; use ambient ONLY for long-lived turn-scoped state
 * that crosses generator boundaries.
 */
let ambient: LogContext | undefined;

export function setAmbientLogContext(ctx: LogContext | undefined): void {
    if (!ctx) {
        ambient = undefined;
        return;
    }
    // Merge into existing ambient — undefined fields don't clobber.
    const merged: LogContext = ambient ? { ...ambient } : {};
    for (const k of Object.keys(ctx) as (keyof LogContext)[]) {
        const v = ctx[k];
        if (v !== undefined) {
            (merged as Record<string, string | undefined>)[k as string] = v;
        }
    }
    ambient = merged;
}

export function clearAmbientLogContextField(field: keyof LogContext): void {
    if (!ambient) return;
    delete ambient[field];
    if (Object.keys(ambient).length === 0) ambient = undefined;
}
