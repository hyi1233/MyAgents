/**
 * Large Value Store — Pattern 2 (v0.2.0 structural refactors).
 *
 * Goal: keep large payloads (tool results, file previews, binary blobs) OUT of
 * the SSE / IPC JSON channel. When a value exceeds `inlineMaxBytes`, spill it
 * to disk under `~/.myagents/refs/<id>` and return a `LargeValueRef` placeholder
 * carrying just a `preview` (head N bytes) plus metadata. Consumers fetch the
 * full body via the sidecar's `GET /refs/:id` endpoint over its existing port.
 *
 * Lifecycle:
 *   - Each ref has a TTL (default 1h) and a `sessionId` tag.
 *   - `clearExpiredRefs()` runs periodically (60s) to evict TTL-expired entries.
 *   - `clearSessionRefs(sessionId)` is called on session-end / reset to release
 *     refs owned by that session early.
 *
 * On-disk layout (under `~/.myagents/refs/`):
 *   <id>            — the actual bytes (Uint8Array | utf-8 text)
 *   <id>.meta.json  — `{ id, sizeBytes, mimetype, preview, expiresAt, sessionId? }`
 *
 * Concurrency: each ref is created with a unique uuid so writers never race;
 * Pattern 5's `withFileLock` is reserved for files that need cross-writer
 * serialization (which a single-writer ref does not).
 */

import { promises as fsp } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

/**
 * Reference placeholder for a large value. Replaces inline bytes in SSE / IPC
 * payloads — the consumer fetches the full body via `GET /refs/:id` when (and
 * only if) it actually needs it.
 *
 * Stable shape — clients (renderer, Rust proxy) discriminate on `kind === 'ref'`.
 */
export interface LargeValueRef {
  kind: 'ref';
  /** Short id (10-char uuid suffix). Stable for the ref's lifetime. */
  id: string;
  /** Total byte size of the full payload on disk. */
  sizeBytes: number;
  /** MIME type — drives renderer decoding (text vs binary, image preview, …). */
  mimetype: string;
  /**
   * Inline preview — head `previewBytes` of the payload as a UTF-8 string when
   * the mimetype is text-like, or the base64-encoded head when binary. The full
   * body is on disk; this is purely for SSE-side previews / log summaries.
   */
  preview: string;
  /** Epoch ms when the ref expires and may be GC'd. */
  expiresAt: number;
}

interface RefMeta extends LargeValueRef {
  /** Optional session tag for `clearSessionRefs`. Empty string = unscoped. */
  sessionId?: string;
}

export interface MaybeSpillOptions {
  /** Default 256 KiB. Values at-or-below this are returned inline. */
  inlineMaxBytes?: number;
  /** Default 8 KiB. Head bytes captured into `LargeValueRef.preview`. */
  previewBytes?: number;
  /** Mimetype tag for the payload (e.g. `text/plain`, `application/json`, `image/png`). */
  mimetype: string;
  /** Default 1h. TTL for the ref before automatic GC. */
  ttlMs?: number;
  /** Optional session tag — `clearSessionRefs(sessionId)` evicts refs by this tag. */
  sessionId?: string;
}

const DEFAULT_INLINE_MAX_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_PREVIEW_BYTES = 8 * 1024; // 8 KiB
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Root directory for spilled ref bodies. Created lazily on first spill so
 * unit tests / fresh installs don't see an empty unused directory.
 *
 * Override via `MYAGENTS_REFS_DIR` (used by tests to isolate the on-disk
 * surface from the shared user dir).
 */
function getRefsDir(): string {
  const override = process.env.MYAGENTS_REFS_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.myagents', 'refs');
}

function ensureRefsDir(): string {
  const dir = getRefsDir();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort; subsequent writeFile will surface a real error */
    }
  }
  return dir;
}

function shortId(): string {
  // uuid is 36 chars w/ hyphens; first segment (8 hex) is unique enough at
  // O(1)/sec ref creation rates and short enough for log lines.
  return randomUUID().split('-')[0];
}

function isTextMimetype(mimetype: string): boolean {
  const lower = mimetype.toLowerCase();
  return lower.startsWith('text/')
    || lower.includes('json')
    || lower.includes('xml')
    || lower.includes('javascript')
    || lower.includes('yaml')
    || lower.includes('csv')
    || lower.includes('html');
}

function buildPreview(value: string | Uint8Array, mimetype: string, previewBytes: number): string {
  if (typeof value === 'string') {
    if (value.length <= previewBytes) return value;
    return value.slice(0, previewBytes);
  }
  // Uint8Array path.
  const head = value.subarray(0, previewBytes);
  if (isTextMimetype(mimetype)) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(head);
    } catch {
      // Fall through to base64.
    }
  }
  // Binary preview — base64 of head bytes. Renderers can show it as a thumbnail
  // or simply as a "head" indicator in tooling.
  return Buffer.from(head).toString('base64');
}

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.meta.json`);
}

function bodyPath(dir: string, id: string): string {
  return join(dir, id);
}

/**
 * Spill if `value` is larger than `inlineMaxBytes`, otherwise return inline.
 *
 * Returns `{ inline }` for small values (caller passes through unchanged) or a
 * `LargeValueRef` for large values (caller embeds `{kind:'ref', id, ...}` into
 * its outgoing SSE / tool result).
 */
export async function maybeSpill(
  value: string | Uint8Array,
  opts: MaybeSpillOptions,
): Promise<{ inline: string | Uint8Array } | LargeValueRef> {
  const inlineMaxBytes = opts.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  const previewBytes = opts.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const sizeBytes = typeof value === 'string'
    ? Buffer.byteLength(value, 'utf-8')
    : value.byteLength;

  if (sizeBytes <= inlineMaxBytes) {
    return { inline: value };
  }

  const dir = ensureRefsDir();
  const id = shortId();
  const expiresAt = Date.now() + ttlMs;
  const preview = buildPreview(value, opts.mimetype, previewBytes);

  const ref: LargeValueRef = {
    kind: 'ref',
    id,
    sizeBytes,
    mimetype: opts.mimetype,
    preview,
    expiresAt,
  };

  const meta: RefMeta = { ...ref };
  if (opts.sessionId) meta.sessionId = opts.sessionId;

  // Write body first, then meta — readers gate on meta.json existing, so a
  // partial write looks like "no such ref" rather than "incomplete ref".
  try {
    if (typeof value === 'string') {
      await fsp.writeFile(bodyPath(dir, id), value, 'utf-8');
    } else {
      await fsp.writeFile(bodyPath(dir, id), value);
    }
    await fsp.writeFile(metaPath(dir, id), JSON.stringify(meta), 'utf-8');
  } catch (err) {
    console.warn(`[refs] spill failed id=${id}: ${err instanceof Error ? err.message : String(err)}`);
    // On failure, fall back to inline so the caller still has data — better
    // than dropping. Caller's SSE pipeline will deal with the size; logs will
    // surface the failure.
    return { inline: value };
  }
  return ref;
}

/**
 * Fetch a previously-spilled ref. Returns `null` if the ref doesn't exist or
 * has expired (TTL).
 *
 * The body is loaded into memory — this matches what the consumer would have
 * seen pre-spill. For very large bodies, prefer streaming via the HTTP route.
 */
export async function fetchRef(id: string): Promise<{ data: Uint8Array; mimetype: string } | null> {
  if (!/^[a-f0-9]+$/i.test(id)) return null; // path-traversal guard
  const dir = getRefsDir();
  let meta: RefMeta;
  try {
    const raw = await fsp.readFile(metaPath(dir, id), 'utf-8');
    meta = JSON.parse(raw) as RefMeta;
  } catch {
    return null;
  }
  if (meta.expiresAt && meta.expiresAt < Date.now()) {
    // Expired — best-effort cleanup.
    void deleteRef(dir, id);
    return null;
  }
  try {
    const body = await fsp.readFile(bodyPath(dir, id));
    return { data: body, mimetype: meta.mimetype };
  } catch {
    return null;
  }
}

/**
 * Streaming-friendly body path lookup. Used by the HTTP `/refs/:id` route to
 * pipe the file directly into the response without loading it into memory.
 *
 * Returns `null` if missing or expired (TTL).
 */
export async function getRefStreamPath(id: string): Promise<{ path: string; mimetype: string; sizeBytes: number } | null> {
  if (!/^[a-f0-9]+$/i.test(id)) return null;
  const dir = getRefsDir();
  let meta: RefMeta;
  try {
    const raw = await fsp.readFile(metaPath(dir, id), 'utf-8');
    meta = JSON.parse(raw) as RefMeta;
  } catch {
    return null;
  }
  if (meta.expiresAt && meta.expiresAt < Date.now()) {
    void deleteRef(dir, id);
    return null;
  }
  return { path: bodyPath(dir, id), mimetype: meta.mimetype, sizeBytes: meta.sizeBytes };
}

async function deleteRef(dir: string, id: string): Promise<void> {
  await fsp.rm(bodyPath(dir, id), { force: true }).catch(() => undefined);
  await fsp.rm(metaPath(dir, id), { force: true }).catch(() => undefined);
}

/**
 * GC entry point. Iterates all refs and removes those whose `expiresAt` is in
 * the past. Cheap enough to run every 60s; failures are swallowed.
 */
export async function clearExpiredRefs(): Promise<void> {
  const dir = getRefsDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(entries
    .filter((name) => name.endsWith('.meta.json'))
    .map(async (name) => {
      const id = name.slice(0, -'.meta.json'.length);
      try {
        const raw = await fsp.readFile(join(dir, name), 'utf-8');
        const meta = JSON.parse(raw) as RefMeta;
        if (meta.expiresAt && meta.expiresAt < now) {
          await deleteRef(dir, id);
        }
      } catch {
        // Corrupt meta — drop it.
        await deleteRef(dir, id);
      }
    }));
}

/**
 * Evict refs tagged with `sessionId`. Called from session-end / reset so refs
 * created during a session don't outlive their consumer.
 */
export async function clearSessionRefs(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const dir = getRefsDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((name) => name.endsWith('.meta.json'))
    .map(async (name) => {
      const id = name.slice(0, -'.meta.json'.length);
      try {
        const raw = await fsp.readFile(join(dir, name), 'utf-8');
        const meta = JSON.parse(raw) as RefMeta;
        if (meta.sessionId === sessionId) {
          await deleteRef(dir, id);
        }
      } catch {
        /* ignore */
      }
    }));
}

/**
 * Kick off the periodic GC. Idempotent — safe to call multiple times; the
 * timer is unref'd so it doesn't keep the event loop alive.
 *
 * Returns a stop handle for tests that want to release the timer.
 */
let gcTimer: ReturnType<typeof setInterval> | undefined;
export function startRefsGc(intervalMs = 60_000): () => void {
  if (gcTimer) return () => stopRefsGc();
  gcTimer = setInterval(() => {
    void clearExpiredRefs();
  }, intervalMs);
  gcTimer.unref?.();
  return () => stopRefsGc();
}

export function stopRefsGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = undefined;
  }
}
